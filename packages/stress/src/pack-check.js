import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACKAGES = Object.freeze([
  { name: '@wardx/core', directory: 'packages/core' },
  { name: 'wardx', directory: 'packages/node' },
  { name: '@wardx/server', directory: 'packages/server' }
]);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
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
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit ${code}`}\n${stdout}${stderr}`
        )
      );
    });
  });
}

async function pack(packageInfo, tarballDirectory, npmEnvironment) {
  const { stdout } = await run(NPM, [
    'pack',
    join(REPOSITORY_ROOT, packageInfo.directory),
    '--json',
    '--pack-destination',
    tarballDirectory
  ], { env: npmEnvironment });
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1, `${packageInfo.name} npm pack must return exactly one tarball`);
  assert.equal(result[0].name, packageInfo.name);
  return join(tarballDirectory, result[0].filename);
}

function waitForPort(stderr) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`packaged server did not report its port:\n${output}`)), 10_000);
    stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/wardx ingest listening on (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolvePromise(Number(match[1]));
    });
    stderr.on('error', reject);
  });
}

async function assertInstalledCopies(projectDirectory) {
  const installedProject = await realpath(projectDirectory);
  for (const packageInfo of PACKAGES) {
    const packagePath = join(projectDirectory, 'node_modules', ...packageInfo.name.split('/'));
    const installedPath = await realpath(packagePath);
    const location = relative(installedProject, installedPath);
    assert.ok(!location.startsWith('..'), `${packageInfo.name} resolved outside the clean install: ${installedPath}`);
    assert.ok(
      location === join('node_modules', ...packageInfo.name.split('/')),
      `${packageInfo.name} resolved through a symlink instead of its tarball: ${installedPath}`
    );
  }
}

async function verifyImports(projectDirectory) {
  const scriptPath = join(projectDirectory, 'verify-imports.mjs');
  await writeFile(
    scriptPath,
    [
      "import assert from 'node:assert/strict';",
      "import { WardxCore } from '@wardx/core';",
      "import { createWardx } from 'wardx';",
      "import { createIngestServer } from '@wardx/server';",
      "assert.equal(typeof WardxCore, 'function');",
      "assert.equal(typeof createWardx, 'function');",
      "assert.equal(typeof createIngestServer, 'function');",
      "process.stdout.write('packaged imports ok\\n');",
      ''
    ].join('\n'),
    'utf8'
  );
  await run(process.execPath, [scriptPath], {
    cwd: projectDirectory,
    env: { ...process.env, NODE_PATH: '' }
  });
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function envelope(role, frames, instanceId) {
  return {
    protocol: 1,
    project: 'demo',
    sdk: { name: 'wardx-pack-check', version: '1.0.0' },
    client: {
      instanceId,
      sessionId: `${instanceId}-session`,
      role,
      appVersion: '1.0.0',
      environment: 'pack-check',
      platform: 'node'
    },
    configVersion: 0,
    frames
  };
}

async function sync(endpoint, body) {
  return fetch(`${endpoint}/v1/sync`, {
    method: 'POST',
    headers: { 'content-encoding': 'gzip', 'x-wardx-key': 'pack-check-trusted-key' },
    body: gzipSync(JSON.stringify(body))
  });
}

async function connectPackagedServer(binary, configPath, projectDirectory, clientName) {
  const transport = new StdioClientTransport({
    command: binary,
    args: [configPath],
    cwd: projectDirectory,
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const portPromise = waitForPort(transport.stderr);
  const client = new Client({ name: clientName, version: '1.0.0' });
  try {
    const [, port] = await Promise.all([client.connect(transport), portPromise]);
    return { client, endpoint: `http://127.0.0.1:${port}`, stderr: () => stderr };
  } catch (error) {
    await client.close().catch(() => {});
    error.message = `${error.message}\npackaged server stderr:\n${stderr}`;
    throw error;
  }
}

async function verifyPackagedBinary(projectDirectory) {
  const sourceConfig = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'config/production.json'), 'utf8'));
  const configPath = join(projectDirectory, 'wardx-server.json');
  sourceConfig.credentials = {
    'pack-check-trusted-key': {
      label: 'pack-check-verifier',
      project: 'demo',
      allowedRoles: ['trusted'],
      trustedForDecisions: true,
      enabled: true
    }
  };
  sourceConfig.history.clockSkewAllowanceMs = 1;
  sourceConfig.history.maxAcceptedPastAgeMs = 604800000;
  sourceConfig.history.compactionIntervalMs = 10;
  sourceConfig.projects.demo.experiments = [];
  sourceConfig.projects.demo.values['pack.variant'] = 'control';
  sourceConfig.projects.demo.keyRoles['pack.variant'] = ['trusted'];
  await writeFile(
    configPath,
    `${JSON.stringify({ ...sourceConfig, host: '127.0.0.1', port: 0, sink: 'null' }, null, 2)}\n`,
    'utf8'
  );
  const binary = join(projectDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'wardx-server.cmd' : 'wardx-server');
  const first = await connectPackagedServer(binary, configPath, projectDirectory, 'wardx-pack-check-first');
  const currentDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  try {
    const response = await fetch(`${first.endpoint}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const readiness = await fetch(`${first.endpoint}/ready`);
    assert.equal(readiness.status, 200);
    assert.equal((await readiness.json()).ok, true);
    const experiment = {
      id: 'pack-terminal-v1',
      enabled: true,
      allocation: 1,
      salt: 'pack-terminal-v1',
      roles: ['trusted'],
      goalMetric: 'pack.goal',
      assignmentUnitKind: 'subject',
      outcomeKind: 'conversion',
      control: 'control',
      targetSampleSizePerVariant: 10,
      earliestAnalysisAt: 0,
      familyWiseAlpha: 0.05,
      minimumEffect: 0,
      direction: 'increase',
      terminalRetentionMs: 604800000,
      healthThresholds: {
        maxDroppedFrames: 0,
        maxDuplicateExposures: 0,
        maxDuplicateGoals: 0,
        maxConflictingGoals: 0,
        maxVariantConflicts: 0,
        maxUntrustedRows: 0,
        maxLateRows: 0,
        maxMissingExposures: 0,
        maxImplicitExposures: 0
      },
      variants: [
        { key: 'control', weight: 1, values: { 'pack.variant': 'control' } },
        { key: 'winner', weight: 1, values: { 'pack.variant': 'winner' } }
      ]
    };
    const mutation = await callTool(first.client, 'upsert_experiment', {
      project: 'demo',
      experiment,
      expectedVersion: 1,
      reason: 'packaged artifact terminal persistence check'
    });
    assert.equal(mutation.version, 2);
    const now = Date.now();
    const events = [];
    for (let index = 0; index < 10; index++) {
      const control = `1${index.toString(16).padStart(15, '0')}`;
      const winner = `2${index.toString(16).padStart(15, '0')}`;
      events.push([now, 'experiment.exposure', { experiment: experiment.id, variant: 'control', subject: control }]);
      events.push([now, 'experiment.exposure', { experiment: experiment.id, variant: 'winner', subject: winner }]);
      events.push([now, 'experiment.goal', {
        metric: experiment.goalMetric,
        subject: winner,
        experiments: [{ experiment: experiment.id, variant: 'winner' }],
        value: 1
      }]);
    }
    const evidence = await sync(first.endpoint, envelope('trusted', [{
      seq: 1,
      from: now - 1,
      to: now,
      metrics: { counters: [], gauges: [], histograms: [] },
      events,
      logs: []
    }], 'pack-evidence'));
    assert.equal(evidence.status, 200);
    assert.equal(
      (await callTool(first.client, 'analyze_experiment', { project: 'demo', experimentId: experiment.id })).decision.status,
      'winner'
    );
    for (const [daysAgo, value] of [[2, 2], [1, 3]]) {
      const timestamp = currentDay - daysAgo * 86_400_000 + 1000;
      const historical = await sync(first.endpoint, envelope('trusted', [{
        seq: 1,
        from: timestamp,
        to: timestamp + 1,
        metrics: { counters: [['pack.history', null, value]], gauges: [], histograms: [] },
        events: [],
        logs: []
      }], `pack-history-${daysAgo}`));
      assert.equal(historical.status, 200);
    }
  } catch (error) {
    error.message = `${error.message}\npackaged server stderr:\n${first.stderr()}`;
    throw error;
  } finally {
    await first.client.close().catch(() => {});
  }

  sourceConfig.history.maxAcceptedPastAgeMs = 1;
  await writeFile(
    configPath,
    `${JSON.stringify({ ...sourceConfig, host: '127.0.0.1', port: 0, sink: 'null' }, null, 2)}\n`,
    'utf8'
  );
  const restarted = await connectPackagedServer(binary, configPath, projectDirectory, 'wardx-pack-check-restart');
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    const persistedConfig = await callTool(restarted.client, 'get_config', { project: 'demo' });
    assert.equal(persistedConfig.version, 2);
    const analysis = await callTool(restarted.client, 'analyze_experiment', {
      project: 'demo', experimentId: 'pack-terminal-v1'
    });
    assert.equal(analysis.decision.status, 'winner');
    const history = await callTool(restarted.client, 'get_aggregate_history', {
      project: 'demo',
      tier: 'day',
      from: currentDay - 2 * 86_400_000,
      to: currentDay,
      role: 'trusted',
      names: ['pack.history']
    });
    assert.deepEqual(history.buckets.map((bucket) => bucket.rows[0].value), [2, 3]);
    assert.equal(history.completeness.allFinalized, true);
  } catch (error) {
    error.message = `${error.message}\nrestarted packaged server stderr:\n${restarted.stderr()}`;
    throw error;
  } finally {
    await restarted.client.close().catch(() => {});
  }

  const recovery = join(projectDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'wardx-recovery.cmd' : 'wardx-recovery');
  const monitor = join(projectDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'wardx-monitor.cmd' : 'wardx-monitor');
  const backupDirectory = join(projectDirectory, 'backup');
  const restoredDirectory = join(projectDirectory, 'restored');
  for (const args of [
    ['backup', configPath, backupDirectory],
    ['verify', backupDirectory],
    ['restore', backupDirectory, restoredDirectory]
  ]) {
    const result = await run(recovery, args, { cwd: projectDirectory });
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const restored = await connectPackagedServer(binary, join(restoredDirectory, 'config.json'), projectDirectory, 'wardx-pack-check-restored');
  try {
    const config = await callTool(restored.client, 'get_config', { project: 'demo' });
    assert.equal(config.version, 2);
    const analysis = await callTool(restored.client, 'analyze_experiment', {
      project: 'demo', experimentId: 'pack-terminal-v1'
    });
    assert.equal(analysis.decision.status, 'winner');
  } finally {
    await restored.client.close().catch(() => {});
  }
  await assert.rejects(run(monitor, [], { cwd: projectDirectory }), /Wardx readiness monitor could not start/);
}

export async function checkPackages() {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-pack-check-'));
  try {
    const tarballDirectory = join(directory, 'tarballs');
    const projectDirectory = join(directory, 'project');
    const cacheDirectory = join(directory, 'npm-cache');
    const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory };
    await Promise.all([mkdir(tarballDirectory), mkdir(projectDirectory), mkdir(cacheDirectory)]);
    const tarballs = await Promise.all(
      PACKAGES.map((packageInfo) => pack(packageInfo, tarballDirectory, npmEnvironment))
    );
    const dependencies = Object.fromEntries(PACKAGES.map((packageInfo, index) => [packageInfo.name, `file:${tarballs[index]}`]));
    await writeFile(
      join(projectDirectory, 'package.json'),
      `${JSON.stringify({ name: 'wardx-packed-artifact-check', private: true, type: 'module', dependencies }, null, 2)}\n`,
      'utf8'
    );
    await run(NPM, ['install', '--no-audit', '--no-fund', '--ignore-scripts=false'], {
      cwd: projectDirectory,
      env: npmEnvironment
    });
    await assertInstalledCopies(projectDirectory);
    await verifyImports(projectDirectory);
    await verifyPackagedBinary(projectDirectory);
    process.stdout.write(
      'pack:check passed: clean tarballs served readiness, persisted state across restart and backup/restore, and exposed the monitor CLI\n'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await checkPackages();
