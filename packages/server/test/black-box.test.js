import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWardx } from 'wardx';
import { testServerConfig } from './helpers.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MCP_HTTP_TOKEN = 'wardx-black-box-mcp-token-at-least-32-bytes';

function serverConfig() {
  return {
    ...testServerConfig(),
    host: '127.0.0.1',
    port: 0,
    credentials: {
      'black-box-key': {
        label: 'black-box-client',
        project: 'demo',
        allowedRoles: ['client', 'frontend', 'backend'],
        trustedForDecisions: false,
        enabled: true
      },
      'trusted-key': {
        label: 'black-box-backend-verifier',
        project: 'demo',
        allowedRoles: ['trusted'],
        trustedForDecisions: true,
        enabled: true
      }
    },
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
    recentEventsMax: 20,
    recentLogsMax: 20,
    history: {
      ...testServerConfig().history,
      clockSkewAllowanceMs: 1,
      maxAcceptedPastAgeMs: 604800000,
      compactionIntervalMs: 10
    },
    mcpHttp: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      bearerTokenEnvironmentVariable: 'WARDX_BLACK_BOX_MCP_TOKEN',
      maxRequestBytes: 65536,
      maxConcurrentRequests: 8,
      allowedHosts: ['127.0.0.1', 'localhost'],
      allowedOrigins: ['http://127.0.0.1']
    },
    projects: {
      demo: {
        version: 1,
        values: {
          'frontend.banner': 'welcome',
          'backend.timeoutMs': 5000,
          'shared.multiplier': 1
        },
        keyRoles: {
          'frontend.banner': ['frontend', 'trusted'],
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
            'frontend.banner': { description: 'Banner text.', category: 'business' },
            'backend.timeoutMs': { description: 'Backend timeout.', category: 'performance' },
            'shared.multiplier': { description: 'Shared multiplier.' },
            'checkout.completed': { description: 'Completed checkouts.', category: 'business' },
            'historical.orders': { description: 'Historical orders.', category: 'business' },
            checkout_failed: { description: 'Checkout failures.', category: 'reliability' }
          },
          inspectEvents: ['checkout.started'],
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

function waitForMcpPort(stderr) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server did not report its MCP HTTP port: ${output}`)), 5000);
    timeout.unref();
    stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/wardx MCP HTTP listening on (\d+)/);
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
  const initialConfig = serverConfig();
  await writeFile(configPath, JSON.stringify(initialConfig), 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, configPath],
    cwd: directory,
    env: { ...process.env, WARDX_BLACK_BOX_MCP_TOKEN: MCP_HTTP_TOKEN },
    stderr: 'pipe'
  });
  let serverStderr = '';
  transport.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString('utf8');
  });
  const portPromise = waitForPort(transport.stderr);
  const mcpPortPromise = waitForMcpPort(transport.stderr);
  const client = new Client({ name: 'wardx-black-box-test', version: '1.0.0' });
  const httpClient = new Client({ name: 'wardx-black-box-http-test', version: '1.0.0' });
  let frontend;
  let backend;
  try {
    const [, port, mcpPort] = await Promise.all([client.connect(transport), portPromise, mcpPortPromise]);
    const endpoint = `http://127.0.0.1:${port}`;
    await httpClient.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${mcpPort}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${MCP_HTTP_TOKEN}` } } }
    ));

    const health = await fetch(`${endpoint}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    assert.deepEqual(await callTool(client, 'list_projects'), { projects: ['demo'] });
    assert.deepEqual(await callTool(httpClient, 'list_projects'), { projects: ['demo'] });

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
    assert.deepEqual((await callTool(client, 'get_recent_events', { project: 'demo' })).events, []);
    assert.deepEqual((await callTool(client, 'get_recent_logs', { project: 'demo' })).logs, []);
    for (const suffix of ['aggregate-windows', 'experiment-stats', 'log-stats']) {
      await assert.rejects(access(`${configPath}.${suffix}.json`), { code: 'ENOENT' });
    }

    frontend = createSdk(endpoint, 'frontend');
    backend = createSdk(endpoint, 'backend');
    await Promise.all([frontend.flush(), backend.flush()]);

    await callTool(client, 'delete_inspect_event', {
      project: 'demo',
      name: 'checkout.started',
      expectedVersion: 1,
      reason: 'verify inspect-event mutation'
    });
    await callTool(client, 'set_inspect_event', {
      project: 'demo',
      name: 'checkout.started',
      expectedVersion: 2,
      reason: 'restore checkout event inspection'
    });

    assert.equal(frontend.config.get('frontend.banner', null), 'welcome');
    assert.equal(frontend.config.get('backend.timeoutMs', 'hidden'), 'hidden');
    assert.equal(frontend.config.get('shared.multiplier', null), 1);
    assert.equal(backend.config.get('backend.timeoutMs', null), 5000);
    assert.equal(backend.config.get('frontend.banner', 'hidden'), 'hidden');
    assert.equal(backend.config.get('shared.multiplier', null), 1);

    await callTool(client, 'set_persist_log', {
      project: 'demo',
      name: 'checkout_failed',
      expectedVersion: 3,
      reason: 'retain checkout failure rollups'
    });
    frontend.counter('checkout.completed', { channel: 'store' }).inc();
    frontend.event('checkout.started', { channel: 'store' });
    frontend.log.error('checkout_failed', { code: 'timeout' });
    await frontend.flush();

    const aggregates = await callTool(client, 'get_aggregates', {
      project: 'demo',
      role: 'frontend',
      names: ['checkout.completed'],
      category: 'business'
    });
    assert.equal(aggregates.windows.length, 1);
    assert.equal(aggregates.windows[0].counters[0].name, 'checkout.completed');
    assert.equal(aggregates.windows[0].counters[0].value, 1);
    assert.equal(aggregates.windows[0].counters[0].role, 'frontend');
    assert.equal(aggregates.windows[0].counters[0].category, 'business');

    const recentLogs = await callTool(client, 'get_recent_logs', {
      project: 'demo',
      role: 'frontend',
      message: 'checkout_failed'
    });
    assert.equal(recentLogs.logs.length, 1);
    assert.equal(recentLogs.logs[0].level, 'error');
    assert.equal(recentLogs.logs[0].attrs.code, 'timeout');

    const recentEvents = await callTool(client, 'get_recent_events', {
      project: 'demo',
      role: 'frontend',
      name: 'checkout.started',
      attrs: { channel: 'store' },
      limit: 1
    });
    assert.equal(recentEvents.events.length, 1);
    assert.equal(recentEvents.events[0].name, 'checkout.started');
    assert.equal(recentEvents.events[0].attrs.channel, 'store');
    assert.equal(recentEvents.events[0].role, 'frontend');
    assert.equal(typeof recentEvents.events[0].instanceId, 'string');

    const update = await callTool(client, 'set_config_value', {
      project: 'demo',
      key: 'frontend.banner',
      value: 'updated',
      roles: ['frontend', 'trusted'],
      expectedVersion: 4,
      reason: 'verify durable Remote Config mutation'
    });
    assert.equal(update.version, 5);
    await frontend.flush();
    assert.equal(frontend.config.get('frontend.banner', null), 'updated');

    const experiment = {
      id: 'banner-v1',
      enabled: true,
      allocation: 1,
      salt: 'banner-v1-salt',
      roles: ['frontend', 'trusted'],
      primaryMetric: 'checkout.completed',
      goalMetric: 'checkout.completed',
      assignmentUnitKind: 'subject',
      terminalRetentionMs: 604800000,
      outcomeKind: 'conversion',
      control: 'control',
      targetSampleSizePerVariant: 10,
      earliestAnalysisAt: 0,
      familyWiseAlpha: 0.05,
      minimumEffect: 0,
      direction: 'increase',
      healthThresholds: {
        maxDroppedFrames: 0,
        maxDuplicateExposures: 0,
        maxDuplicateGoals: 0,
        maxConflictingGoals: 0,
        maxVariantConflicts: 0,
        maxUntrustedRows: 10,
        maxLateRows: 0,
        maxMissingExposures: 0,
        maxImplicitExposures: 0
      },
      hypothesis: 'The declared banner increases completed checkouts.',
      variants: [
        { key: 'control', weight: 1, values: { 'frontend.banner': 'updated' } },
        { key: 'winner', weight: 1, values: { 'frontend.banner': 'experiment-winner' } }
      ]
    };
    const proposed = await callTool(client, 'upsert_experiment', {
      project: 'demo',
      experiment,
      expectedVersion: 5,
      reason: 'test trusted fixed-horizon experiment flow'
    });
    assert.equal(proposed.version, 6);
    await frontend.flush();
    const rawSubject = 'account-raw-subject-must-not-leak';
    frontend.identify(rawSubject);
    frontend.experiment.goal('checkout.completed');
    await frontend.flush();

    const evidenceEvents = [];
    for (let i = 0; i < 10; i++) {
      const controlHash = `1${i.toString(16).padStart(63, '0')}`;
      const winnerHash = `2${i.toString(16).padStart(63, '0')}`;
      evidenceEvents.push([Date.now(), 'experiment.exposure', {
        experiment: 'banner-v1', variant: 'control', subject: controlHash
      }]);
      evidenceEvents.push([Date.now(), 'experiment.exposure', {
        experiment: 'banner-v1', variant: 'winner', subject: winnerHash
      }]);
      evidenceEvents.push([Date.now(), 'experiment.goal', {
        metric: 'checkout.completed',
        subject: winnerHash,
        experiments: [{ experiment: 'banner-v1', variant: 'winner' }],
        value: 1
      }]);
    }
    const trustedEvidence = await rawSync(endpoint, wireEnvelope({
      client: { role: 'trusted', instanceId: 'trusted-verifier' },
      frames: [{
        seq: 1,
        from: Date.now() - 1,
        to: Date.now(),
        metrics: { counters: [], gauges: [], histograms: [] },
        events: evidenceEvents,
        logs: []
      }]
    }), { key: 'trusted-key' });
    assert.equal(trustedEvidence.status, 200);

    const analysis = await callTool(client, 'analyze_experiment', {
      project: 'demo',
      experimentId: 'banner-v1'
    });
    const winnerEvidence = analysis.variants.find((row) => row.key === 'winner');
    assert.equal(winnerEvidence.exposures, 10);
    assert.equal(winnerEvidence.goals, 10);
    assert.equal(analysis.decision.status, 'winner');
    assert.equal(analysis.decision.leadingVariant, 'winner');
    assert.equal(JSON.stringify(analysis).includes(rawSubject), false);
    const shipped = await callTool(client, 'ship_experiment', {
      project: 'demo',
      experimentId: 'banner-v1',
      expectedVersion: 6,
      reason: 'ship persisted healthy winner'
    });
    assert.equal(shipped.shippedVariant, 'winner');
    assert.equal(shipped.version, 7);

    const currentDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    for (const [daysAgo, value] of [[2, 2], [1, 3]]) {
      const timestamp = currentDay - daysAgo * 86_400_000 + 1000;
      const historical = await rawSync(endpoint, wireEnvelope({
        client: { role: 'frontend', instanceId: `history-${daysAgo}` },
        frames: [{
          seq: 1,
          from: timestamp,
          to: timestamp + 1,
          metrics: { counters: [['historical.orders', null, value]], gauges: [], histograms: [] },
          events: [],
          logs: []
        }]
      }));
      assert.equal(historical.status, 200);
    }

    await Promise.all([frontend.shutdown(), backend.shutdown()]);
    frontend = undefined;
    backend = undefined;
    await httpClient.close();
    await client.close();

    initialConfig.history.maxAcceptedPastAgeMs = 1;
    await writeFile(configPath, JSON.stringify(initialConfig), 'utf8');

    const restartedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, configPath],
      cwd: directory,
      env: { ...process.env, WARDX_BLACK_BOX_MCP_TOKEN: MCP_HTTP_TOKEN },
      stderr: 'pipe'
    });
    restartedTransport.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString('utf8');
    });
    const restartedPort = waitForPort(restartedTransport.stderr);
    const restartedClient = new Client({ name: 'wardx-black-box-restart-test', version: '1.0.0' });
    try {
      await Promise.all([restartedClient.connect(restartedTransport), restartedPort]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const persistedConfig = await callTool(restartedClient, 'get_config', { project: 'demo' });
      assert.equal(persistedConfig.version, 7);
      assert.equal(persistedConfig.values['frontend.banner'], 'experiment-winner');
      assert.equal(persistedConfig.experiments[0].enabled, false);
      const persistedExperiment = await callTool(restartedClient, 'analyze_experiment', {
        project: 'demo',
        experimentId: 'banner-v1'
      });
      const persistedWinner = persistedExperiment.variants.find((row) => row.key === 'winner');
      assert.equal(persistedWinner.exposures, 10);
      assert.equal(persistedWinner.goals, 10);
      assert.equal(persistedExperiment.decision.status, 'shipped');
      const persistedHistory = await callTool(restartedClient, 'get_aggregate_history', {
        project: 'demo',
        tier: 'day',
        from: currentDay - 2 * 86_400_000,
        to: currentDay,
        role: 'frontend',
        names: ['historical.orders'],
        category: 'business'
      });
      assert.equal(persistedHistory.buckets.length, 2);
      assert.deepEqual(
        persistedHistory.buckets.map((bucket) => bucket.rows[0].value),
        [2, 3]
      );
      assert.equal(persistedHistory.completeness.allFinalized, true);
      const overview = await callTool(restartedClient, 'get_project_overview', {
        project: 'demo',
        category: 'business'
      });
      assert.deepEqual(overview.categories, ['business', 'performance', 'reliability']);
      assert.deepEqual(overview.inspectEvents, ['checkout.started']);
      assert.deepEqual(overview.persistLogs, ['checkout_failed']);
      assert.deepEqual((await callTool(restartedClient, 'get_recent_events', { project: 'demo' })).events, []);
      assert.deepEqual((await callTool(restartedClient, 'get_recent_logs', { project: 'demo' })).logs, []);
      const changes = await callTool(restartedClient, 'list_config_changes', { project: 'demo' });
      const shippedChange = changes.changes.find((change) => change.operation === 'ship_experiment');
      assert.ok(shippedChange);
      const rollback = await callTool(restartedClient, 'rollback_config_change', {
        project: 'demo',
        changeId: shippedChange.id,
        expectedVersion: 7,
        reason: 'black-box rollback verification'
      });
      assert.equal(rollback.version, 8);
      const rolledBackConfig = await callTool(restartedClient, 'get_config', { project: 'demo' });
      assert.equal(rolledBackConfig.values['frontend.banner'], 'updated');
      assert.equal(rolledBackConfig.experiments[0].enabled, true);
    } finally {
      await restartedClient.close().catch(() => {});
    }
  } catch (err) {
    err.message = `${err.message}\nserver stderr:\n${serverStderr}`;
    throw err;
  } finally {
    await Promise.allSettled([frontend?.shutdown(), backend?.shutdown()]);
    await httpClient.close().catch(() => {});
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
