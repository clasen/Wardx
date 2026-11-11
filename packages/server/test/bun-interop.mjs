import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { testServerConfig } from './helpers.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_PATH = join(REPOSITORY_ROOT, 'packages/server/src/cli.js');
const BUN_CLIENT_PATH = join(REPOSITORY_ROOT, 'packages/node/test/bun-client.js');
const SERVER_RUNTIME = process.argv[2] ?? 'node';
if (!['node', 'bun'].includes(SERVER_RUNTIME)) throw new Error('usage: bun-interop.mjs [node|bun]');

function config(ndjsonPath) {
  return {
    ...testServerConfig(),
    credentials: {
      'bun-interop-key': {
        label: 'bun-interop-client',
        project: 'demo',
        allowedRoles: ['backend'],
        trustedForDecisions: true,
        enabled: true
      }
    },
    sink: 'ndjson',
    ndjsonPath,
    persistenceFlushIntervalMs: 50,
    diagnostics: { sink: 'stderr' },
    projects: {
      demo: {
        version: 1,
        values: { 'interop.remote': 'base' },
        keyRoles: { 'interop.remote': ['backend'] },
        keyRules: {
          'interop.remote': [{ when: [{ field: 'attributes.tier', op: 'lt', value: 2 }], value: 'conditional' }]
        },
        experiments: [
          {
            id: 'bun-interop-v1',
            enabled: true,
            allocation: 1,
            salt: 'bun-interop-v1-salt',
            roles: ['backend'],
            primaryMetric: 'interop.counter',
            goalMetric: 'interop.goal',
            assignmentUnitKind: 'subject',
            terminalRetentionMs: 604800000,
            variants: [
              { key: 'experiment', weight: 1, values: { 'interop.remote': 'experiment' } }
            ]
          }
        ]
      }
    }
  };
}

function waitForPort(stderr) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`wardx-server did not report a port:\n${output}`)), 10_000);
    stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/wardx ingest listening on (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolvePromise(Number(match[1]));
    });
    stderr.on('error', reject);
  });
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}\n${stdout}${stderr}`));
    });
  });
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function verify() {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-bun-interop-'));
  const configPath = join(directory, 'server.json');
  const ndjsonPath = join(directory, 'ingest.ndjson');
  await writeFile(configPath, `${JSON.stringify(config(ndjsonPath), null, 2)}\n`, 'utf8');
  const transport = new StdioClientTransport({
    command: SERVER_RUNTIME === 'bun' ? 'bun' : process.execPath,
    args: [CLI_PATH, configPath],
    cwd: directory,
    stderr: 'pipe'
  });
  let serverStderr = '';
  transport.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString('utf8');
  });
  const portPromise = waitForPort(transport.stderr);
  const client = new Client({ name: 'wardx-bun-interop', version: '1.0.0' });
  try {
    const [, port] = await Promise.all([client.connect(transport), portPromise]);
    const bun = await run('bun', [BUN_CLIENT_PATH, `http://127.0.0.1:${port}`], REPOSITORY_ROOT);
    assert.deepEqual(JSON.parse(bun.stdout.trim()), { ok: true, remote: 'experiment' });

    const overview = await callTool(client, 'get_project_overview', { project: 'demo' });
    const runtime = overview.roles.backend.clients[0];
    assert.equal(runtime.role, 'backend');
    assert.equal(runtime.appVersion, '1.0.0');
    const analysis = await callTool(client, 'analyze_experiment', {
      project: 'demo',
      experimentId: 'bun-interop-v1'
    });
    assert.equal(analysis.variants[0].exposures, 1);
    assert.equal(analysis.variants[0].goals, 1);
    assert.equal(analysis.variants[0].goalSum, 2);
    await client.close();

    const envelopes = (await readFile(ndjsonPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(envelopes.length >= 1);
    assert.ok(envelopes.every((envelope) => envelope.sdk.name === 'wardx-node'));
    assert.equal(JSON.stringify(envelopes).includes('interop-subject'), false);
    assert.equal(JSON.stringify(envelopes).includes('interop-private-hid'), false);
    const frames = envelopes.flatMap((envelope) => envelope.frames);
    const counters = frames.flatMap((frame) => frame.metrics.counters);
    const histograms = frames.flatMap((frame) => frame.metrics.histograms || []);
    const distincts = frames.flatMap((frame) => frame.metrics.distincts || []);
    const events = frames.flatMap((frame) => frame.events);
    const logs = frames.flatMap((frame) => frame.logs || []);
    assert.ok(counters.some((row) => row[0] === 'interop.counter' && row[1].runtime === 'bun' && row[2] === 3));
    assert.ok(histograms.some((row) => row[0] === 'interop.latency'));
    assert.ok(distincts.some((row) => row[0] === 'interop.hids'));
    assert.ok(events.some((row) => row[1] === 'interop.event'));
    assert.equal(events.filter((row) => row[1] === 'experiment.exposure').length, 1);
    assert.equal(events.filter((row) => row[1] === 'experiment.goal').length, 1);
    assert.ok(logs.length >= 1);
    process.stdout.write(`Bun SDK interoperability passed against wardx-server CLI on ${SERVER_RUNTIME}\n`);
  } catch (error) {
    error.message = `${error.message}\nwardx-server stderr:\n${serverStderr}`;
    throw error;
  } finally {
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

await verify();
