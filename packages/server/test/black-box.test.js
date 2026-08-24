import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWardx } from 'wardx';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function serverConfig() {
  return {
    host: '127.0.0.1',
    port: 0,
    projectKeys: { 'black-box-key': 'demo' },
    sink: 'null',
    maxRequestBytes: 2097152,
    maxClockSkewMs: 300000,
    maxFramesPerEnvelope: 256,
    maxItemsPerEnvelope: 10000,
    maxNameBytes: 256,
    maxDimensionKeys: 8,
    maxDimensionValueLength: 64,
    maxAttributeKeys: 32,
    maxAttributeValueLength: 1024,
    persistenceFlushIntervalMs: 250,
    diagnostics: { sink: 'stderr' },
    aggregateRetentionMinutes: 60,
    aggregateMaxSeriesPerMetric: 1000,
    memorySinkMaxEnvelopes: 100,
    recentClientsMax: 20,
    recentLogsMax: 20,
    projects: {
      demo: {
        version: 1,
        values: {
          'frontend.banner': 'welcome',
          'backend.timeoutMs': 5000,
          'shared.multiplier': 1
        },
        keyRoles: {
          'frontend.banner': ['frontend'],
          'backend.timeoutMs': ['backend'],
          'shared.multiplier': ['*']
        },
        experiments: [],
        catalog: {
          description: 'Black-box product.',
          roles: {
            frontend: { description: 'Player-facing client.' },
            backend: { description: 'Backend service.' }
          },
          signals: {
            'frontend.banner': 'Banner text.',
            'backend.timeoutMs': 'Backend timeout.',
            'shared.multiplier': 'Shared multiplier.',
            'checkout.completed': 'Completed checkouts.',
            checkout_failed: 'Checkout failures.'
          },
          persistLogs: [],
          experiments: {}
        }
      }
    }
  };
}

function waitForPort(stderr) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server did not report its port: ${output}`)), 5000);
    timeout.unref();
    stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/wardx ingest listening on (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    stderr.on('error', reject);
  });
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

function createSdk(endpoint, role) {
  return createWardx({
    endpoint,
    projectKey: 'black-box-key',
    project: 'demo',
    role,
    appVersion: '1.0.0',
    environment: 'test',
    privacySalt: 'black-box-privacy-salt',
    aggregateIntervalMs: 60_000,
    syncIntervalMs: 60_000
  });
}

function wireEnvelope(overrides = {}) {
  const { client, ...rest } = overrides;
  return {
    protocol: 1,
    project: 'demo',
    sdk: { name: 'wardx-node', version: '0.1.0' },
    client: {
      instanceId: '01BLACKBOXINSTANCE00000000',
      sessionId: '01BLACKBOXSESSION000000000',
      role: 'frontend',
      appVersion: '1.0.0',
      environment: 'test',
      platform: 'node',
      ...client
    },
    configVersion: 0,
    frames: [],
    ...rest
  };
}

async function rawSync(endpoint, body, options = {}) {
  const headers = {};
  if (options.key !== null) headers['x-wardx-key'] = options.key ?? 'black-box-key';
  if (options.encoding !== null) headers['content-encoding'] = options.encoding ?? 'gzip';
  let payload = body;
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  if ((options.encoding ?? 'gzip') === 'gzip' && !options.alreadyEncoded) payload = gzipSync(payload);
  return fetch(`${endpoint}/v1/sync`, { method: 'POST', headers, body: payload });
}

test('documented SDK, HTTP, role config, experiments, persistence, and MCP flow work end to end', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-black-box-'));
  const configPath = join(directory, 'wardx-server.json');
  await writeFile(configPath, JSON.stringify(serverConfig()), 'utf8');

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
  const client = new Client({ name: 'wardx-black-box-test', version: '1.0.0' });
  let frontend;
  let backend;
  try {
    const [, port] = await Promise.all([client.connect(transport), portPromise]);
    const endpoint = `http://127.0.0.1:${port}`;

    const health = await fetch(`${endpoint}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    assert.deepEqual(await callTool(client, 'list_projects'), { projects: ['demo'] });

    const invalidHistogram = wireEnvelope({
      frames: [
        {
          seq: 1,
          from: Date.now() - 1,
          to: Date.now(),
          metrics: {
            counters: [],
            gauges: [],
            histograms: [['latency', null, { count: 1, sum: 1, min: 2, max: 1, buckets: [] }]]
          },
          events: [],
          logs: []
        }
      ]
    });
    const stringCounter = wireEnvelope({
      frames: [
        {
          seq: 1,
          from: Date.now() - 1,
          to: Date.now(),
          metrics: { counters: [['requests', null, '1']], gauges: [], histograms: [] },
          events: [],
          logs: []
        }
      ]
    });
    const excessiveItems = wireEnvelope({
      frames: [
        {
          seq: 1,
          from: Date.now() - 1,
          to: Date.now(),
          metrics: {
            counters: Array.from({ length: serverConfig().maxItemsPerEnvelope + 1 }, () => ['requests', null, 1]),
            gauges: [],
            histograms: []
          },
          events: [],
          logs: []
        }
      ]
    });
    const nonFiniteTimestamp = JSON.stringify(wireEnvelope({ frames: [] })).replace(
      '"configVersion":0',
      '"configVersion":1e400'
    );
    const hostileCases = [
      ['missing key', wireEnvelope(), { key: null }, 401],
      ['unknown key', wireEnvelope(), { key: 'unknown-key' }, 401],
      ['project mismatch', wireEnvelope({ project: 'other' }), {}, 400],
      ['corrupt gzip', Buffer.from('not-gzip'), { alreadyEncoded: true }, 400],
      ['invalid json', '{', {}, 400],
      ['unsupported encoding', '{}', { encoding: 'br', alreadyEncoded: true }, 415],
      ['invalid protocol', wireEnvelope({ protocol: 2 }), {}, 400],
      ['empty role', wireEnvelope({ client: { role: '' } }), {}, 400],
      ['reserved role', wireEnvelope({ client: { role: '*' } }), {}, 400],
      ['non-finite number', nonFiniteTimestamp, {}, 400],
      [
        'future timestamp',
        wireEnvelope({
          frames: [
            {
              seq: 1,
              from: Date.now() + serverConfig().maxClockSkewMs + 1000,
              to: Date.now() + serverConfig().maxClockSkewMs + 1000,
              metrics: { counters: [], gauges: [], histograms: [] },
              events: [],
              logs: []
            }
          ]
        }),
        {},
        400
      ],
      ['string counter', stringCounter, {}, 400],
      [
        'malformed reserved experiment attrs',
        wireEnvelope({
          frames: [
            {
              seq: 1,
              from: Date.now() - 1,
              to: Date.now(),
              metrics: { counters: [], gauges: [], histograms: [] },
              events: [[Date.now(), 'experiment.goal', null]],
              logs: []
            }
          ]
        }),
        {},
        400
      ],
      [
        'malformed tuple',
        wireEnvelope({
          frames: [
            {
              seq: 1,
              from: Date.now() - 1,
              to: Date.now(),
              metrics: { counters: [['requests']], gauges: [], histograms: [] },
              events: [],
              logs: []
            }
          ]
        }),
        {},
        400
      ],
      ['invalid histogram', invalidHistogram, {}, 400],
      ['excessive collection', excessiveItems, {}, 400],
      [
        'decoded oversized',
        wireEnvelope({ client: { role: 'x'.repeat(serverConfig().maxRequestBytes) } }),
        {},
        413
      ],
      [
        'compressed oversized',
        Buffer.alloc(serverConfig().maxRequestBytes + 1),
        { alreadyEncoded: true },
        413
      ]
    ];
    for (const [name, body, options, status] of hostileCases) {
      const response = await rawSync(endpoint, body, options);
      assert.equal(response.status, status, name);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(serverStderr, /"type":"ingest\.validation_rejected"/);
    const removedAdmin = await fetch(`${endpoint}/v1/admin/aggregates`);
    assert.equal(removedAdmin.status, 404);

    assert.deepEqual((await callTool(client, 'get_aggregates', { project: 'demo' })).windows, []);
    assert.deepEqual((await callTool(client, 'get_recent_logs', { project: 'demo' })).logs, []);
    for (const suffix of ['aggregate-windows', 'experiment-stats', 'log-stats']) {
      await assert.rejects(access(`${configPath}.${suffix}.json`), { code: 'ENOENT' });
    }

    frontend = createSdk(endpoint, 'frontend');
    backend = createSdk(endpoint, 'backend');
    await Promise.all([frontend.flush(), backend.flush()]);

    assert.equal(frontend.config.get('frontend.banner', null), 'welcome');
    assert.equal(frontend.config.get('backend.timeoutMs', 'hidden'), 'hidden');
    assert.equal(frontend.config.get('shared.multiplier', null), 1);
    assert.equal(backend.config.get('backend.timeoutMs', null), 5000);
    assert.equal(backend.config.get('frontend.banner', 'hidden'), 'hidden');
    assert.equal(backend.config.get('shared.multiplier', null), 1);

    await callTool(client, 'set_persist_log', { project: 'demo', name: 'checkout_failed' });
    frontend.counter('checkout.completed', { channel: 'store' }).inc();
    frontend.log.error('checkout_failed', { code: 'timeout' });
    await frontend.flush();

    const aggregates = await callTool(client, 'get_aggregates', {
      project: 'demo',
      role: 'frontend',
      names: ['checkout.completed']
    });
    assert.equal(aggregates.windows.length, 1);
    assert.equal(aggregates.windows[0].counters[0].name, 'checkout.completed');
    assert.equal(aggregates.windows[0].counters[0].value, 1);
    assert.equal(aggregates.windows[0].counters[0].role, 'frontend');

    const recentLogs = await callTool(client, 'get_recent_logs', {
      project: 'demo',
      role: 'frontend',
      message: 'checkout_failed'
    });
    assert.equal(recentLogs.logs.length, 1);
    assert.equal(recentLogs.logs[0].level, 'error');
    assert.equal(recentLogs.logs[0].attrs.code, 'timeout');

    const update = await callTool(client, 'set_config_value', {
      project: 'demo',
      key: 'frontend.banner',
      value: 'updated',
      roles: ['frontend']
    });
    assert.equal(update.version, 2);
    await frontend.flush();
    assert.equal(frontend.config.get('frontend.banner', null), 'updated');

    const experiment = {
      id: 'banner-v1',
      enabled: true,
      allocation: 1,
      salt: 'banner-v1-salt',
      roles: ['frontend'],
      primaryMetric: 'checkout.completed',
      goalMetric: 'checkout.completed',
      goalKind: 'conversion',
      control: 'winner',
      minExposures: 1,
      confidence: 0.95,
      hypothesis: 'The declared banner increases completed checkouts.',
      variants: [{ key: 'winner', weight: 1, values: { 'frontend.banner': 'experiment-winner' } }]
    };
    const proposed = await callTool(client, 'upsert_experiment', { project: 'demo', experiment });
    assert.equal(proposed.version, 3);
    await frontend.flush();
    const rawSubject = 'account-raw-subject-must-not-leak';
    frontend.identify(rawSubject);
    assert.equal(frontend.config.get('frontend.banner', null), 'experiment-winner');
    assert.equal(frontend.config.get('frontend.banner', null), 'experiment-winner');
    frontend.experiment.goal('checkout.completed');
    await frontend.flush();

    const analysis = await callTool(client, 'analyze_experiment', {
      project: 'demo',
      experimentId: 'banner-v1'
    });
    assert.equal(analysis.variants[0].exposures, 1);
    assert.equal(analysis.variants[0].goals, 1);
    assert.equal(analysis.decision.status, 'winner');
    assert.equal(analysis.decision.leadingVariant, 'winner');
    assert.equal(JSON.stringify(analysis).includes(rawSubject), false);
    const shipped = await callTool(client, 'ship_experiment', {
      project: 'demo',
      experimentId: 'banner-v1'
    });
    assert.equal(shipped.shippedVariant, 'winner');
    assert.equal(shipped.version, 4);

    await Promise.all([frontend.shutdown(), backend.shutdown()]);
    frontend = undefined;
    backend = undefined;
    await client.close();

    const restartedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, configPath],
      cwd: directory,
      stderr: 'pipe'
    });
    restartedTransport.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString('utf8');
    });
    const restartedPort = waitForPort(restartedTransport.stderr);
    const restartedClient = new Client({ name: 'wardx-black-box-restart-test', version: '1.0.0' });
    try {
      await Promise.all([restartedClient.connect(restartedTransport), restartedPort]);
      const persistedConfig = await callTool(restartedClient, 'get_config', { project: 'demo' });
      assert.equal(persistedConfig.version, 4);
      assert.equal(persistedConfig.values['frontend.banner'], 'experiment-winner');
      assert.equal(persistedConfig.experiments[0].enabled, false);
      const persistedExperiment = await callTool(restartedClient, 'analyze_experiment', {
        project: 'demo',
        experimentId: 'banner-v1'
      });
      assert.equal(persistedExperiment.variants[0].exposures, 1);
      assert.equal(persistedExperiment.variants[0].goals, 1);
      assert.equal(persistedExperiment.decision.status, 'shipped');
      const persistedAggregates = await callTool(restartedClient, 'get_aggregates', { project: 'demo' });
      assert.ok(persistedAggregates.windows.length >= 1);
      const overview = await callTool(restartedClient, 'get_project_overview', { project: 'demo' });
      assert.deepEqual(overview.persistLogs, ['checkout_failed']);
      assert.ok(
        overview.roles.frontend.outcomes.some(
          (row) => row.kind === 'log' && row.name === 'checkout_failed' && row.count === 1
        )
      );
      assert.deepEqual((await callTool(restartedClient, 'get_recent_logs', { project: 'demo' })).logs, []);
    } finally {
      await restartedClient.close().catch(() => {});
    }
  } catch (err) {
    err.message = `${err.message}\nserver stderr:\n${serverStderr}`;
    throw err;
  } finally {
    await Promise.allSettled([frontend?.shutdown(), backend?.shutdown()]);
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
