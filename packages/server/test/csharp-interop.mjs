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
const CSHARP_PROJECT = join(REPOSITORY_ROOT, 'clients/csharp/Tests/Wardx.Tests.csproj');

function config(ndjsonPath) {
  return {
    ...testServerConfig(),
    host: '127.0.0.1',
    port: 0,
    credentials: {
      'black-box-key': {
        label: 'black-box-client',
        project: 'demo',
        allowedRoles: ['csharp'],
        trustedForDecisions: true,
        enabled: true
      }
    },
    sink: 'ndjson',
    ndjsonPath,
    maxRequestBytes: 2097152,
    maxClockSkewMs: 300000,
    maxFramesPerEnvelope: 256,
    maxItemsPerEnvelope: 10000,
    maxNameBytes: 256,
    maxDimensionKeys: 8,
    maxDimensionValueLength: 64,
    maxAttributeKeys: 32,
    maxAttributeValueLength: 1024,
    persistenceFlushIntervalMs: 50,
    diagnostics: { sink: 'stderr' },
    aggregateRetentionMinutes: 60,
    aggregateMaxSeriesPerMetric: 1000,
    memorySinkMaxEnvelopes: 100,
    recentClientsMax: 20,
    recentEventsMax: 20,
    recentLogsMax: 20,
    projects: {
      demo: {
        version: 1,
        values: {
          'interop.remote': 'base',
          'interop.hidden': 'not-for-csharp'
        },
        keyRoles: {
          'interop.remote': ['csharp'],
          'interop.hidden': ['frontend']
        },
        experiments: [
          {
            id: 'csharp-interop-v1',
            enabled: true,
            allocation: 1,
            salt: 'csharp-interop-v1-salt',
            roles: ['csharp'],
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
  const directory = await mkdtemp(join(tmpdir(), 'wardx-csharp-interop-'));
  const configPath = join(directory, 'server.json');
  const ndjsonPath = join(directory, 'ingest.ndjson');
  await writeFile(configPath, `${JSON.stringify(config(ndjsonPath), null, 2)}\n`, 'utf8');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, configPath],
    cwd: directory,
    stderr: 'pipe'
  });
  let serverStderr = '';
  transport.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString('utf8');
  });
  const portPromise = waitForPort(transport.stderr);
  const client = new Client({ name: 'wardx-csharp-interop', version: '1.0.0' });
  try {
    const [, port] = await Promise.all([client.connect(transport), portPromise]);
    const endpoint = `http://127.0.0.1:${port}`;
    const dotnet = await run(
      'dotnet',
      ['run', '--project', CSHARP_PROJECT, '--no-build', '--no-restore', '--', 'interop', endpoint],
      REPOSITORY_ROOT
    );
    assert.deepEqual(JSON.parse(dotnet.stdout.trim()), { ok: true, remote: 'experiment' });

    const overview = await callTool(client, 'get_project_overview', { project: 'demo' });
    const runtime = overview.roles.csharp.clients[0];
    assert.equal(runtime.role, 'csharp');
    assert.equal(runtime.platform, 'csharp');
    assert.equal(runtime.appVersion, '1.0.0');
    const analysis = await callTool(client, 'analyze_experiment', {
      project: 'demo',
      experimentId: 'csharp-interop-v1'
    });
    assert.equal(analysis.variants[0].exposures, 1);
    assert.equal(analysis.variants[0].goals, 1);
    assert.equal(analysis.variants[0].goalSum, 2);
    assert.equal(analysis.decision.status, 'invalid');
    assert.match(analysis.decision.reason, /descriptive experiment/);
    const aggregates = await callTool(client, 'get_aggregates', { project: 'demo', names: ['interop.hids'] });
    const distinct = aggregates.windows.flatMap((window) => window.distincts).find((row) => row.name === 'interop.hids');
    assert.equal(distinct.estimate, 1);
    assert.equal('registers' in distinct, false);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
    const retention = await callTool(client, 'get_retention', { project: 'demo', from: today, to: tomorrow });
    assert.equal(retention.cohorts[0].users, 1);
    assert.ok(retention.cohorts[0].returns.every((row) => row.status === 'pending'));
    await client.close();

    const envelopes = (await readFile(ndjsonPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(envelopes.length >= 2);
    assert.ok(envelopes.every((envelope) => envelope.sdk.name === 'wardx-csharp'));
    assert.ok(envelopes.every((envelope) => envelope.client.platform === 'csharp'));
    assert.equal(JSON.stringify(envelopes).includes('interop-subject'), false);
    assert.equal(JSON.stringify(envelopes).includes('interop-private-hid'), false);
    const frames = envelopes.flatMap((envelope) => envelope.frames);
    const counters = frames.flatMap((frame) => frame.metrics.counters);
    const events = frames.flatMap((frame) => frame.events);
    const distincts = frames.flatMap((frame) => frame.metrics.distincts || []);
    assert.ok(counters.some((row) => row[0] === 'interop.counter' && row[2] === 1));
    assert.ok(distincts.some((row) => row[0] === 'interop.hids' && row[2].precision === 9));
    assert.equal(events.filter((row) => row[1] === 'experiment.exposure').length, 1);
    assert.equal(events.filter((row) => row[1] === 'experiment.goal').length, 1);
    assert.ok(events.some((row) => row[1] === 'interop.event'));
    const activity = events.find((row) => row[1] === 'retention.activity');
    const exposure = events.find((row) => row[1] === 'experiment.exposure');
    assert.equal(activity[2].subject, exposure[2].subject);
    for (let index = 1; index < frames.length; index++) {
      assert.equal(frames[index].seq, frames[index - 1].seq + 1);
    }
    process.stdout.write('C# interoperability passed against wardx-server CLI\n');
  } catch (error) {
    error.message = `${error.message}\nwardx-server stderr:\n${serverStderr}`;
    throw error;
  } finally {
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

await verify();
