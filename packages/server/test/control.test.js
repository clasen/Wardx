import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadServerConfig } from '../src/loadConfig.js';
import { executeTool } from '../src/mcp/tools.js';
import { createIngestServer, listen } from '../src/server.js';
import { gzipJson, sampleEnvelope, testServerConfig } from './helpers.js';

const DELAY_EXPERIMENT = {
  id: 'message-delay-v1',
  enabled: true,
  allocation: 1,
  salt: '3ad8f9',
  primaryMetric: 'message.sent',
  goalMetric: 'message.sent',
  assignmentUnitKind: 'subject',
  terminalRetentionMs: 604800000,
  roles: ['client'],
  variants: [
    { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
    { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
  ]
};

async function withServer(config, fn) {
  const server = createIngestServer(config);
  const address = await listen(server, config.port, config.host);
  const base = `http://${address.address}:${address.port}`;
  try {
    return await fn(server, base);
  } finally {
    await server.wardx.stop();
  }
}

function mutate(control, method, project, ...args) {
  return control[method](project, ...args, {
    expectedVersion: control.getConfig(project).version,
    reason: `test ${method}`
  });
}

function executeMutation(control, name, args) {
  return executeTool(control, name, {
    ...args,
    expectedVersion: control.getConfig(args.project).version,
    reason: `test ${name}`
  });
}

test('ControlService upserts experiments and increments version', () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  assert.equal(control.getConfig('demo').version, 12);
  mutate(control, 'upsertExperiment', 'demo', DELAY_EXPERIMENT);
  const snapshot = control.getConfig('demo');
  assert.equal(snapshot.version, 13);
  assert.equal(snapshot.experiments[0].id, 'message-delay-v1');
  mutate(control, 'setExperimentEnabled', 'demo', 'message-delay-v1', false);
  assert.equal(control.getConfig('demo').experiments[0].enabled, false);
  assert.equal(control.getConfig('demo').version, 14);
});

test('ControlService deleteValue rejects a missing key', () => {
  const server = createIngestServer(testServerConfig());
  assert.throws(() => server.wardx.control.deleteValue('demo', 'missing'), /unknown config key/);
});

test('ControlService persists mutations to SQLite without rewriting operational config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  const input = testServerConfig({ port: 0 });
  input.sqlite.path = join(dir, 'state.sqlite');
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`);
  try {
    const beforeFile = readFileSync(path, 'utf8');
    const config = loadServerConfig(path);
    const server = createIngestServer(config);
    mutate(server.wardx.control, 'setValue', 'demo', 'message.delayMs', 250, ['client']);
    await server.wardx.stop();
    assert.equal(readFileSync(path, 'utf8'), beforeFile);
    const restarted = createIngestServer(loadServerConfig(path));
    assert.equal(restarted.wardx.control.getConfig('demo').values['message.delayMs'], 250);
    assert.equal(restarted.wardx.control.getConfig('demo').version, 13);
    await restarted.wardx.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ControlService does not publish config or catalog when durable commit fails', () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  const beforeConfig = control.getConfig('demo');
  const beforeCatalog = structuredClone(control.getCatalog('demo'));
  const reports = [];
  control.diagnostics = { report(...args) { reports.push(args); } };
  server.wardx.stateStore.commitProjectMutation = () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };

  assert.throws(
    () => mutate(control, 'setValue', 'demo', 'message.delayMs', 250, ['client']),
    /disk full/
  );
  assert.deepEqual(control.getConfig('demo'), beforeConfig);
  assert.throws(() => mutate(control, 'setProjectDescription', 'demo', 'not published'), /disk full/);
  assert.deepEqual(control.getCatalog('demo'), beforeCatalog);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((entry) => entry[0]), ['control.persistence_failed', 'control.persistence_failed']);
  assert.ok(reports.every((entry) => entry[1].code === 'ENOSPC'));
});

test('optimistic mutations journal once, conflict cleanly, and rollback as a new version', () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  const first = control.setValue('demo', 'message.delayMs', 250, ['client'], {
    expectedVersion: 12,
    reason: 'lower message delay'
  });
  assert.equal(first.version, 13);
  assert.throws(
    () => control.setValue('demo', 'message.delayMs', 100, ['client'], {
      expectedVersion: 12,
      reason: 'stale writer'
    }),
    (error) => error.code === 'version_conflict' && error.currentVersion === 13
  );
  assert.equal(control.getConfig('demo').values['message.delayMs'], 250);
  const beforeRollback = control.listConfigChanges('demo');
  assert.equal(beforeRollback.changes.length, 1);
  assert.equal(beforeRollback.changes[0].reason, 'lower message delay');
  assert.equal(JSON.stringify(beforeRollback).includes('test-key'), false);

  const rolledBack = control.rollbackConfigChange('demo', first.changeId, {
    expectedVersion: 13,
    reason: 'restore the previous delay'
  });
  assert.equal(rolledBack.version, 14);
  assert.equal(control.getConfig('demo').values['message.delayMs'], 1000);
  const afterRollback = control.listConfigChanges('demo');
  assert.equal(afterRollback.changes.length, 2);
  assert.equal(afterRollback.changes[1].operation, 'rollback_config_change');
  assert.equal(afterRollback.changes[1].rolledBackChangeId, first.changeId);
});

test('aggregator rolls up experiment exposure and goals', async () => {
  const now = Date.now();
  await withServer(testServerConfig(), async (server, base) => {
    mutate(server.wardx.control, 'upsertExperiment', 'demo', DELAY_EXPERIMENT);
    const envelope = sampleEnvelope({
      frames: [
        {
          seq: 1,
          from: now - 1000,
          to: now,
          metrics: {
            counters: [['message.sent', null, 4]],
            gauges: [],
            histograms: []
          },
          events: [
            [now - 900, 'experiment.exposure', { experiment: 'message-delay-v1', variant: 'fast', subject: 'ab'.repeat(32) }],
            [
              now - 800,
              'experiment.goal',
              {
                metric: 'message.sent',
                subject: 'ab'.repeat(32),
                experiments: [{ experiment: 'message-delay-v1', variant: 'fast' }],
                value: 1
              }
            ],
            [now - 700, 'purchase', { product: 'premium' }]
          ],
          logs: []
        }
      ]
    });
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(envelope)
    });
    const windows = server.wardx.control.aggregates('demo');
    assert.equal(windows[0].eventNames.find((row) => row.name === 'purchase').count, 1);
    const analysis = server.wardx.control.analyzeExperiment('demo', 'message-delay-v1');
    assert.equal(analysis.experiment.id, 'message-delay-v1');
    const fast = analysis.telemetryVariants.find((row) => row.key === 'fast');
    assert.equal(fast.exposures, 1);
    assert.equal(fast.goals, 1);
    assert.equal(fast.goalSum, 1);
    assert.equal(fast.goalMean, 1);
    assert.equal(analysis.variants.length, 0);
    assert.equal(analysis.decision.status, 'cannot_decide');
    assert.equal(analysis.primaryMetric.name, 'message.sent');
    assert.equal(analysis.primaryMetric.total, 4);
    const clients = server.wardx.control.recentClients('demo');
    assert.equal(clients[0].instanceId, '01TESTINSTANCE000000000000');
    assert.equal(clients[0].platform, 'node');
    assert.equal(clients[0].role, 'client');
  });
});

test('executeTool exposes control operations without HTTP', () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  assert.deepEqual(executeTool(control, 'list_projects'), { projects: ['demo'] });
  executeMutation(control, 'set_config_value', {
    project: 'demo',
    key: 'chat.enabled',
    value: false,
    roles: ['client']
  });
  const snapshot = executeTool(control, 'get_config', { project: 'demo' });
  assert.equal(snapshot.values['chat.enabled'], false);
  executeMutation(control, 'upsert_experiment', { project: 'demo', experiment: DELAY_EXPERIMENT });
  const listed = executeTool(control, 'list_experiments', { project: 'demo' });
  assert.equal(listed.experiments.length, 1);
  executeMutation(control, 'set_signal', {
    project: 'demo',
    name: 'message.sent',
    description: 'Chat messages that left the client after the delay'
  });
  const analysis = executeTool(control, 'analyze_experiment', {
    project: 'demo',
    experimentId: 'message-delay-v1'
  });
  assert.equal(analysis.experiment.id, 'message-delay-v1');
  assert.equal(analysis.primaryMetric.description, 'Chat messages that left the client after the delay');
  assert.throws(() => executeTool(control, 'nope'), /unknown tool/);
});

test('catalog mutations persist atomically in SQLite and bump configVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  try {
    const config = loadServerConfig(path);
    const server = createIngestServer(config);
    const control = server.wardx.control;
    assert.equal(control.getConfig('demo').version, 12);
    mutate(control, 'setProjectDescription', 'demo', 'Demo chat app.');
    mutate(control, 'setRoleDescription', 'demo', 'unity', 'Player client.');
    mutate(control, 'setRoleSource', 'demo', 'unity', {
      path: '/src/alfa-unity',
      git: 'https://github.com/acme/alfa-unity'
    });
    mutate(control, 'setSignal', 'demo', 'message.delayMs', 'Milliseconds to wait before sending a chat message');
    assert.equal(control.getConfig('demo').version, 16);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.projects.demo.version, 12);
    assert.equal(control.getCatalog('demo').description, 'Demo chat app.');
    assert.equal(control.getCatalog('demo').roles.unity.description, 'Player client.');
    assert.equal(control.getCatalog('demo').roles.unity.path, '/src/alfa-unity');
    assert.equal(control.getCatalog('demo').roles.unity.git, 'https://github.com/acme/alfa-unity');
    const overview = executeTool(control, 'get_project_overview', { project: 'demo' });
    assert.equal(overview.roles.unity.path, '/src/alfa-unity');
    assert.equal(overview.roles.unity.git, 'https://github.com/acme/alfa-unity');
    assert.throws(
      () => executeMutation(control, 'set_role_source', { project: 'demo', role: 'unity' }),
      /path or git is required/
    );
    assert.equal(
      control.getCatalog('demo').signals['message.delayMs'],
      'Milliseconds to wait before sending a chat message'
    );
    executeMutation(control, 'set_persist_log', { project: 'demo', name: 'payment_failed' });
    assert.deepEqual(control.getCatalog('demo').persistLogs, ['payment_failed']);
    executeMutation(control, 'delete_persist_log', { project: 'demo', name: 'payment_failed' });
    assert.deepEqual(control.getCatalog('demo').persistLogs, []);
    assert.throws(
      () => executeMutation(control, 'delete_persist_log', { project: 'demo', name: 'payment_failed' }),
      /unknown persist log: payment_failed/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overview splits knobs and outcomes and marks undescribed names', async () => {
  const now = Date.now();
  await withServer(testServerConfig(), async (server, base) => {
    const control = server.wardx.control;
    mutate(control, 'setSignal', 'demo', 'message.delayMs', 'Milliseconds to wait before sending a chat message');
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(
        sampleEnvelope({
          frames: [
            {
              seq: 1,
              from: now - 1000,
              to: now,
              metrics: {
                counters: [['message.sent', null, 4]],
                gauges: [],
                histograms: []
              },
              events: [[now - 700, 'purchase', { product: 'premium' }]],
              logs: []
            }
          ]
        })
      )
    });
    const overview = executeTool(control, 'get_project_overview', { project: 'demo' });
    const delay = overview.knobs.find((row) => row.key === 'message.delayMs');
    assert.equal(delay.value, 1000);
    assert.deepEqual(delay.roles, ['client']);
    assert.equal(delay.description, 'Milliseconds to wait before sending a chat message');
    assert.equal(delay.undescribed, undefined);
    const chat = overview.knobs.find((row) => row.key === 'chat.enabled');
    assert.equal(chat.undescribed, true);
    const sent = overview.roles.client.outcomes.find(
      (row) => row.kind === 'counter' && row.name === 'message.sent'
    );
    assert.equal(sent.value, 4);
    assert.equal(sent.undescribed, true);
    const purchase = overview.roles.client.outcomes.find(
      (row) => row.kind === 'event' && row.name === 'purchase'
    );
    assert.equal(purchase.count, 1);
    assert.equal(overview.onboarding.complete, false);
    assert.equal(overview.onboarding.missingDescription, true);
    assert.deepEqual(overview.onboarding.undescribedKnobs, ['chat.enabled']);
    assert.deepEqual(overview.onboarding.undescribedOutcomes, ['message.sent', 'purchase']);
    assert.deepEqual(overview.onboarding.undescribedRoles, ['client']);
    assert.deepEqual(overview.persistLogs, []);
  });
});

test('overview ranks histogram peaks by max and keeps the exemplar', async () => {
  const now = Date.now();
  await withServer(
    testServerConfig({
      projects: {
        demo: {
          version: 12,
          values: {
            'message.delayMs': 1000,
            'chat.enabled': true,
            'economy.maxAward': 500
          },
          keyRoles: {
            'message.delayMs': ['game-server'],
            'chat.enabled': ['client'],
            'economy.maxAward': ['game-server']
          },
          experiments: []
        }
      }
    }),
    async (server, base) => {
      const control = server.wardx.control;
      mutate(control, 'setSignal', 'demo', 'economy.maxAward', 'Largest legal coin grant');
      mutate(control, 'setSignal', 'demo', 'coins.award_size', 'Distribution of coin grant amounts');
      mutate(control, 'setRoleSource', 'demo', 'game-server', { path: '/src/game-server' });
      await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-wardx-key': 'test-key'
        },
        body: gzipJson(
          sampleEnvelope({
            client: { role: 'game-server' },
            frames: [
              {
                seq: 1,
                from: now - 1000,
                to: now,
                metrics: {
                  counters: [
                    ['coins.awarded', { source: 'match' }, 8120],
                    ['coins.grants', { source: 'match' }, 3]
                  ],
                  gauges: [],
                  histograms: [
                    [
                      'coins.award_size',
                      { source: 'match' },
                      {
                        count: 3,
                        sum: 8120,
                        min: 40,
                        max: 8000,
                        buckets: [[5000, 2]],
                        exemplar: { value: 8000, attrs: { grantId: 'g-80', reason: 'bonus' } }
                      }
                    ]
                  ]
                },
                events: [[now - 200, 'coins.anomaly', { source: 'match', amount: 8000, grantId: 'g-80' }]],
                logs: [
                  [
                    now - 100,
                    'warn',
                    'coins_anomaly',
                    { source: 'match', amount: 8000, reason: 'bonus', grantId: 'g-80' }
                  ]
                ]
              }
            ]
          })
        )
      });
      const overview = executeTool(control, 'get_project_overview', { project: 'demo' });
      const cap = overview.knobs.find((row) => row.key === 'economy.maxAward');
      assert.equal(cap.value, 500);
      const peak = overview.roles['game-server'].outcomes.find(
        (row) => row.kind === 'histogram' && row.name === 'coins.award_size'
      );
      assert.equal(peak.max, 8000);
      assert.equal(peak.count, 3);
      assert.deepEqual(peak.exemplar, { value: 8000, attrs: { grantId: 'g-80', reason: 'bonus' } });
      assert.equal(peak.description, 'Distribution of coin grant amounts');
      assert.equal(overview.roles['game-server'].path, '/src/game-server');
      assert.equal(overview.onboarding.undescribedOutcomes.includes('coins.award_size'), false);
      const anomaly = overview.roles['game-server'].outcomes.find(
        (row) => row.kind === 'event' && row.name === 'coins.anomaly'
      );
      assert.equal(anomaly.count, 1);
      const rows = executeTool(control, 'get_recent_logs', {
        project: 'demo',
        message: 'coins_anomaly',
        attrs: { grantId: 'g-80' }
      });
      assert.equal(rows.logs.length, 1);
      assert.equal(rows.logs[0].attrs.reason, 'bonus');
    }
  );
});

test('overview onboarding completes after catalog answers and skips protocol names', async () => {
  const now = Date.now();
  await withServer(testServerConfig(), async (server, base) => {
    const control = server.wardx.control;
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(
        sampleEnvelope({
          frames: [
            {
              seq: 1,
              from: now - 1000,
              to: now,
              metrics: {
                counters: [
                  ['message.sent', null, 4],
                  ['wardx.internal.frames_sent', null, 1]
                ],
                gauges: [],
                histograms: []
              },
              events: [
                [now - 800, 'experiment.exposure', { experiment: 'x', variant: 'a' }],
                [now - 700, 'purchase', { product: 'premium' }]
              ],
              logs: []
            }
          ]
        })
      )
    });
    const before = executeTool(control, 'get_project_overview', { project: 'demo' });
    assert.equal(before.onboarding.complete, false);
    assert.equal(before.onboarding.undescribedOutcomes.includes('wardx.internal.frames_sent'), false);
    assert.equal(before.onboarding.undescribedOutcomes.includes('experiment.exposure'), false);
    mutate(control, 'setProjectDescription', 'demo', 'Demo chat app.');
    mutate(control, 'setRoleDescription', 'demo', 'client', 'Player-facing client.');
    mutate(control, 'setSignal', 'demo', 'message.delayMs', 'Milliseconds to wait before sending a chat message');
    mutate(control, 'setSignal', 'demo', 'chat.enabled', 'Whether chat is available');
    mutate(control, 'setSignal', 'demo', 'message.sent', 'Chat messages that left the client after the delay');
    mutate(control, 'setSignal', 'demo', 'purchase', 'A completed in-app purchase');
    const after = executeTool(control, 'get_project_overview', { project: 'demo' });
    assert.deepEqual(after.onboarding, {
      complete: true,
      missingDescription: false,
      undescribedKnobs: [],
      undescribedOutcomes: [],
      undescribedRoles: []
    });
  });
});

test('predefined catalog skips onboarding until a new name appears', async () => {
  const now = Date.now();
  const config = testServerConfig({
    projects: {
      demo: {
        version: 12,
        values: {
          'message.delayMs': 1000,
          'chat.enabled': true
        },
        keyRoles: {
          'message.delayMs': ['client'],
          'chat.enabled': ['client']
        },
        experiments: [],
        catalog: {
          description: 'Demo chat app.',
          roles: {
            client: { description: 'Player-facing client.', path: '/repo/client' }
          },
          signals: {
            'message.delayMs': 'Milliseconds to wait before sending a chat message',
            'chat.enabled': 'Whether chat is available',
            'message.sent': 'Chat messages that left the client after the delay'
          }
        }
      }
    }
  });
  await withServer(config, async (server, base) => {
    const control = server.wardx.control;
    const seeded = executeTool(control, 'get_project_overview', { project: 'demo' });
    assert.deepEqual(seeded.onboarding, {
      complete: true,
      missingDescription: false,
      undescribedKnobs: [],
      undescribedOutcomes: [],
      undescribedRoles: []
    });
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(
        sampleEnvelope({
          frames: [
            {
              seq: 1,
              from: now - 1000,
              to: now,
              metrics: {
                counters: [['message.sent', null, 4]],
                gauges: [],
                histograms: []
              },
              events: [[now - 700, 'purchase', { product: 'premium' }]],
              logs: []
            }
          ]
        })
      )
    });
    const gap = executeTool(control, 'get_project_overview', { project: 'demo' });
    assert.equal(gap.onboarding.complete, false);
    assert.equal(gap.onboarding.missingDescription, false);
    assert.deepEqual(gap.onboarding.undescribedKnobs, []);
    assert.deepEqual(gap.onboarding.undescribedOutcomes, ['purchase']);
  });
});

test('upsertExperiment rejects unknown Remote Config keys', () => {
  const server = createIngestServer(testServerConfig());
  assert.throws(
    () =>
      mutate(server.wardx.control, 'upsertExperiment', 'demo', {
        ...DELAY_EXPERIMENT,
        variants: [{ key: 'fast', weight: 1, values: { 'missing.key': 1 } }]
      }),
    /unknown config key: missing.key/
  );
});

test('upsertExperiment hypothesis stays off the client snapshot', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    const control = server.wardx.control;
    mutate(control, 'upsertExperiment', 'demo', {
      ...DELAY_EXPERIMENT,
      hypothesis: 'Shorter delay increases messages sent'
    });
    const listed = control.listExperiments('demo');
    assert.equal(listed[0].hypothesis, 'Shorter delay increases messages sent');
    assert.equal(control.getConfig('demo').experiments[0].hypothesis, undefined);
    const analysis = control.analyzeExperiment('demo', 'message-delay-v1');
    assert.equal(analysis.experiment.hypothesis, 'Shorter delay increases messages sent');
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    assert.equal(json.configVersion, 13);
    assert.equal(json.config.experiments[0].id, 'message-delay-v1');
    assert.equal(json.config.experiments[0].hypothesis, undefined);
    assert.equal(json.config.catalog, undefined);
  });
});

test('get_recent_logs returns recent rows of every level', async () => {
  const now = Date.now();
  await withServer(testServerConfig({ recentLogsMax: 10 }), async (server, base) => {
    const control = server.wardx.control;
    mutate(control, 'setSignal', 'demo', 'payment_failed', 'One failed charge with provider code and stack');
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(
        sampleEnvelope({
          frames: [
            {
              seq: 1,
              from: now - 1000,
              to: now,
              metrics: { counters: [], gauges: [], histograms: [] },
              events: [],
              logs: [
                [now - 400, 'debug', 'noisy', null],
                [now - 300, 'info', 'match_started', { mode: 'ranked' }],
                [now - 200, 'error', 'payment_failed', { code: 'timeout', stack: 'PaymentError: timeout' }],
                [now - 100, 'error', 'payment_failed', { code: 'card_declined', stack: 'PaymentError: declined' }],
                [now - 10, 'error', 'payment_failed', { code: 'timeout', stack: 'PaymentError: timeout again' }]
              ]
            }
          ]
        })
      )
    });
    const all = executeTool(control, 'get_recent_logs', { project: 'demo' });
    assert.deepEqual(
      all.logs.map((row) => row.level),
      ['error', 'error', 'error', 'info', 'debug']
    );
    assert.equal(all.logs[0].attrs.stack, 'PaymentError: timeout again');
    assert.equal(all.logs[0].description, 'One failed charge with provider code and stack');
    assert.equal(all.logs[0].instanceId, '01TESTINSTANCE000000000000');
    const timeout = executeTool(control, 'get_recent_logs', {
      project: 'demo',
      message: 'payment_failed',
      attrs: { code: 'timeout' },
      limit: 1
    });
    assert.equal(timeout.logs.length, 1);
    assert.equal(timeout.logs[0].attrs.stack, 'PaymentError: timeout again');
    const debug = executeTool(control, 'get_recent_logs', { project: 'demo', level: 'debug' });
    assert.equal(debug.logs.length, 1);
    assert.equal(debug.logs[0].message, 'noisy');
    assert.throws(
      () => executeTool(control, 'get_recent_logs', { project: 'demo', level: 'fatal' }),
      /level must be debug, info, warn, or error/
    );
    assert.throws(
      () => executeTool(control, 'get_recent_logs', { project: 'demo', attrs: { stack: { nested: true } } }),
      /attrs\.stack must be a string, number, or boolean/
    );
  });
});

test('recent log ring drops the oldest row when full', async () => {
  const now = Date.now();
  await withServer(testServerConfig({ recentLogsMax: 2 }), async (server, base) => {
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(
        sampleEnvelope({
          frames: [
            {
              seq: 1,
              from: now - 1000,
              to: now,
              metrics: { counters: [], gauges: [], histograms: [] },
              events: [],
              logs: [
                [now - 30, 'info', 'match_started', { code: 'first' }],
                [now - 20, 'error', 'payment_failed', { code: 'second' }],
                [now - 10, 'debug', 'noisy', { code: 'third' }]
              ]
            }
          ]
        })
      )
    });
    const rows = executeTool(server.wardx.control, 'get_recent_logs', { project: 'demo' });
    assert.deepEqual(
      rows.logs.map((row) => row.attrs.code),
      ['third', 'second']
    );
  });
});

test('Remote Config is filtered to the syncing role', async () => {
  const values = {
    'message.delayMs': 1000,
    'matchmaking.timeoutMs': 5000
  };
  await withServer(
    testServerConfig({
      projects: {
        demo: {
          version: 12,
          values,
          keyRoles: {
            'message.delayMs': ['unity'],
            'matchmaking.timeoutMs': ['game-server']
          },
          experiments: []
        }
      }
    }),
    async (_server, base) => {
      const headers = {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      };
      const unity = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers,
        body: gzipJson(sampleEnvelope({ client: { role: 'unity' }, frames: [] }))
      });
      const unityJson = await unity.json();
      assert.equal(unityJson.config.values['message.delayMs'], 1000);
      assert.equal(unityJson.config.values['matchmaking.timeoutMs'], undefined);
      const game = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers,
        body: gzipJson(sampleEnvelope({ client: { role: 'game-server' }, frames: [] }))
      });
      const gameJson = await game.json();
      assert.equal(gameJson.config.values['matchmaking.timeoutMs'], 5000);
      assert.equal(gameJson.config.values['message.delayMs'], undefined);
    }
  );
});

test('same metric names from different roles stay separate', async () => {
  const now = Date.now();
  await withServer(testServerConfig(), async (server, base) => {
    const headers = {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'x-wardx-key': 'test-key'
    };
    const frame = {
      seq: 1,
      from: now - 1000,
      to: now,
      metrics: { counters: [['screen.view', { surface: 'home' }, 3]], gauges: [], histograms: [] },
      events: [[now - 500, 'session.start', { channel: 'organic' }]],
      logs: []
    };
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers,
      body: gzipJson(sampleEnvelope({ client: { role: 'desktop', instanceId: 'desktop-1' }, frames: [frame] }))
    });
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers,
      body: gzipJson(sampleEnvelope({ client: { role: 'mobile', instanceId: 'mobile-1' }, frames: [frame] }))
    });
    const overview = executeTool(server.wardx.control, 'get_project_overview', { project: 'demo' });
    const desktop = overview.roles.desktop.outcomes.find((row) => row.name === 'screen.view');
    const mobile = overview.roles.mobile.outcomes.find((row) => row.name === 'screen.view');
    assert.equal(desktop.value, 3);
    assert.equal(mobile.value, 3);
    assert.equal(overview.roles.desktop.clients[0].instanceId, 'desktop-1');
    assert.equal(overview.roles.mobile.clients[0].instanceId, 'mobile-1');
    const desktopOnly = executeTool(server.wardx.control, 'get_aggregates', {
      project: 'demo',
      role: 'desktop',
      names: ['screen.view']
    });
    assert.equal(desktopOnly.windows[0].counters.length, 1);
    assert.equal(desktopOnly.windows[0].counters[0].role, 'desktop');
  });
});

test('upsertExperiment rejects a key not visible to experiment.roles', () => {
  const server = createIngestServer(testServerConfig());
  assert.throws(
    () =>
      mutate(server.wardx.control, 'upsertExperiment', 'demo', {
        ...DELAY_EXPERIMENT,
        roles: ['game-server']
      }),
    /config key message.delayMs is not visible to role game-server/
  );
});

test('createMcpServer constructs an SDK server', async () => {
  const { createMcpServer } = await import('../src/mcp/stdio.js');
  const httpServer = createIngestServer(testServerConfig());
  const mcp = createMcpServer(httpServer.wardx.control);
  assert.equal(typeof mcp.connect, 'function');
});

const SHIPPABLE = {
  ...DELAY_EXPERIMENT,
  outcomeKind: 'conversion',
  control: 'control',
  targetSampleSizePerVariant: 50,
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
    maxUntrustedRows: 0,
    maxLateRows: 0,
    maxMissingExposures: 0,
    maxImplicitExposures: 0
  },
  hypothesis: 'Shorter delay increases messages sent'
};

function assignmentHash(variant, index) {
  const prefix = variant === 'control' ? '1' : '2';
  return `${prefix}${index.toString(16).padStart(63, '0')}`;
}

function ingestVariant(ledger, variant, exposures, goals, now = Date.now()) {
  const events = [];
  for (let i = 0; i < exposures; i++) {
    events.push({
      kind: 'exposure',
      timestamp: now,
      experiment: SHIPPABLE.id,
      variant,
      assignmentHash: assignmentHash(variant, i)
    });
  }
  for (let i = 0; i < goals; i++) {
    events.push({
      kind: 'goal',
      timestamp: now,
      experiment: SHIPPABLE.id,
      variant,
      assignmentHash: assignmentHash(variant, i),
      value: 1
    });
  }
  ledger.ingestBatch('demo', events, { role: 'game-server', trustedForDecisions: true });
}

test('analyze_experiment is cannot_decide without a close policy', () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  mutate(control, 'upsertExperiment', 'demo', DELAY_EXPERIMENT);
  const analysis = executeTool(control, 'analyze_experiment', {
    project: 'demo',
    experimentId: 'message-delay-v1'
  });
  assert.equal(analysis.decision.status, 'cannot_decide');
  assert.equal(analysis.decision.next, 'configure');
});

test('ship_experiment copies the winner and disables the experiment', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    const control = server.wardx.control;
    mutate(control, 'upsertExperiment', 'demo', SHIPPABLE);
    ingestVariant(server.wardx.experimentLedger, 'control', 50, 10);
    ingestVariant(server.wardx.experimentLedger, 'fast', 50, 40);
    const analysis = executeTool(control, 'analyze_experiment', {
      project: 'demo',
      experimentId: 'message-delay-v1'
    });
    assert.equal(analysis.decision.status, 'winner');
    assert.equal(analysis.decision.leadingVariant, 'fast');
    const shipped = executeMutation(control, 'ship_experiment', {
      project: 'demo',
      experimentId: 'message-delay-v1'
    });
    assert.equal(shipped.shippedVariant, 'fast');
    const snapshot = control.getConfig('demo');
    assert.equal(snapshot.values['message.delayMs'], 400);
    assert.equal(snapshot.experiments[0].enabled, false);
    assert.equal(snapshot.experiments[0].shippedVariant, 'fast');
    assert.equal(snapshot.experiments[0].outcomeKind, 'conversion');
    const again = executeMutation(control, 'ship_experiment', {
      project: 'demo',
      experimentId: 'message-delay-v1'
    });
    assert.equal(again.version, snapshot.version);
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    assert.equal(json.config.values['message.delayMs'], 400);
    assert.equal(json.config.experiments[0].enabled, false);
    assert.equal(json.config.experiments[0].shippedVariant, undefined);
  });
});

test('ship_experiment refuses while collecting', () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  mutate(control, 'upsertExperiment', 'demo', SHIPPABLE);
  ingestVariant(server.wardx.experimentLedger, 'control', 10, 4);
  ingestVariant(server.wardx.experimentLedger, 'fast', 12, 8);
  const analysis = control.analyzeExperiment('demo', 'message-delay-v1');
  assert.equal(analysis.decision.status, 'collecting');
  assert.throws(
    () => executeMutation(control, 'ship_experiment', { project: 'demo', experimentId: 'message-delay-v1' }),
    /not ready to ship/
  );
});

test('close-policy fields stay off the client wire', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    mutate(server.wardx.control, 'upsertExperiment', 'demo', SHIPPABLE);
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    const experiment = json.config.experiments[0];
    assert.equal(experiment.id, 'message-delay-v1');
    assert.equal(experiment.goalMetric, 'message.sent');
    assert.equal(experiment.assignmentUnitKind, undefined);
    assert.equal(experiment.outcomeKind, undefined);
    assert.equal(experiment.control, undefined);
    assert.equal(experiment.targetSampleSizePerVariant, undefined);
    assert.equal(experiment.familyWiseAlpha, undefined);
    assert.equal(experiment.shippedVariant, undefined);
    assert.equal(experiment.hypothesis, undefined);
  });
});

test('upsertExperiment rejects a control that is not a variant', () => {
  const server = createIngestServer(testServerConfig());
  assert.throws(
    () => server.wardx.control.upsertExperiment('demo', { ...SHIPPABLE, control: 'missing' }),
    /experiment.control must be a variant key/
  );
});
