import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersistenceCoordinator, writeJsonAtomic } from '../src/control/PersistenceCoordinator.js';
import { aggregateWindowsPath, experimentStatsPath, logStatsPath } from '../src/control/persist.js';
import { ProjectRegistry } from '../src/projects/ProjectRegistry.js';
import { SqliteStateStore } from '../src/storage/SqliteStateStore.js';
import { sampleEnvelope, testServerConfig } from './helpers.js';

const diagnostics = { report() {} };

function sqliteSettings(config) {
  return {
    synchronous: config.sqlite.synchronous,
    busyTimeoutMs: config.sqlite.busyTimeoutMs,
    walAutoCheckpointPages: config.sqlite.walAutoCheckpointPages,
    checkpointMode: config.sqlite.checkpointMode,
    maxWriteBatch: config.sqlite.maxWriteBatchRows,
    transactionTimeoutMs: config.sqlite.transactionTimeoutMs,
    maxHistoryBuckets: config.history.maxQueryBuckets,
    maxHistoryRows: config.history.maxQueryRows
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(writeAtomic, diagnosticSink = diagnostics) {
  const config = testServerConfig({ configPath: '/tmp/wardx-persistence-test.json' });
  const registry = new ProjectRegistry(config);
  registry.get('demo').aggregator.ingest(sampleEnvelope());
  const coordinator = new PersistenceCoordinator({ config, registry, diagnostics: diagnosticSink, writeAtomic });
  return { coordinator, registry };
}

test('PersistenceCoordinator coalesces burst marks into one write', async () => {
  let writes = 0;
  const { coordinator } = setup(async () => {
    writes += 1;
  });
  for (let i = 0; i < 100; i++) coordinator.mark('aggregateWindows');
  await coordinator.flush();
  assert.equal(writes, 1);
  assert.equal(coordinator.snapshotMetrics().writes, 1);
  assert.equal(coordinator.snapshotMetrics().dirty, false);
});

test('PersistenceCoordinator writes again when data changes during a write', async () => {
  const started = deferred();
  const release = deferred();
  let writes = 0;
  let active = 0;
  let maxActive = 0;
  const { coordinator, registry } = setup(async () => {
    writes += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (writes === 1) {
      started.resolve();
      await release.promise;
    }
    active -= 1;
  });
  coordinator.mark('aggregateWindows');
  const flushing = coordinator.flush();
  await started.promise;
  registry.get('demo').aggregator.ingest(sampleEnvelope());
  coordinator.mark('aggregateWindows');
  release.resolve();
  await flushing;
  assert.equal(writes, 2);
  assert.equal(maxActive, 1);
});

test('PersistenceCoordinator preserves dirty state after failure and retries', async () => {
  let attempts = 0;
  const reports = [];
  const { coordinator } = setup(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  }, { report(...args) { reports.push(args); } });
  coordinator.mark('aggregateWindows');
  await assert.rejects(coordinator.flush(), /disk full/);
  assert.equal(coordinator.snapshotMetrics().dirty, true);
  assert.equal(coordinator.snapshotMetrics().writeFailures, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'persistence.flush_failed');
  assert.equal(reports[0][1].code, 'ENOSPC');
  await coordinator.flush();
  assert.equal(attempts, 2);
  assert.equal(coordinator.snapshotMetrics().dirty, false);
  assert.equal(coordinator.snapshotMetrics().writes, 1);
});

test('PersistenceCoordinator preserves dirty state after a permission failure', async () => {
  let attempts = 0;
  const { coordinator } = setup(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  coordinator.mark('aggregateWindows');
  await assert.rejects(coordinator.flush(), (error) => error.code === 'EACCES');
  assert.equal(coordinator.snapshotMetrics().dirty, true);
  assert.equal(coordinator.snapshotMetrics().writeFailures, 1);
  await coordinator.flush();
  assert.equal(attempts, 2);
  assert.equal(coordinator.snapshotMetrics().dirty, false);
});

test('PersistenceCoordinator flush persists the final aggregate, log, and experiment snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-persistence-'));
  const configPath = join(directory, 'server.json');
  const config = testServerConfig({ configPath });
  const registry = new ProjectRegistry(config);
  registry.get('demo').catalog.persistLogs.push('payment_failed');
  const now = Date.now();
  const envelope = sampleEnvelope({
    frames: [
      {
        seq: 1,
        from: now - 1,
        to: now,
        metrics: { counters: [['requests', null, 1]], gauges: [], histograms: [] },
        events: [
          [now, 'experiment.exposure', { experiment: 'delay', variant: 'fast', subject: 'ab'.repeat(32) }],
          [
            now,
            'experiment.goal',
            {
              metric: 'message.sent',
              subject: 'ab'.repeat(32),
              experiments: [{ experiment: 'delay', variant: 'fast' }]
            }
          ]
        ],
        logs: [[now, 'error', 'payment_failed', { code: 'timeout' }]]
      }
    ]
  });
  const changed = registry.get('demo').aggregator.ingest(envelope, ['payment_failed']);
  const coordinator = new PersistenceCoordinator({ config, registry, diagnostics });
  if (changed.windows) coordinator.mark('aggregateWindows');
  if (changed.experiments) coordinator.mark('experimentStats');
  if (changed.persistLogs) coordinator.mark('logStats');
  try {
    await coordinator.flush();
    const aggregate = JSON.parse(await readFile(aggregateWindowsPath(configPath), 'utf8'));
    const experiments = JSON.parse(await readFile(experimentStatsPath(configPath), 'utf8'));
    const logs = JSON.parse(await readFile(logStatsPath(configPath), 'utf8'));
    assert.equal(aggregate.projects.demo[0].counters[0].value, 1);
    assert.equal(experiments.projects.demo.delay.fast.goals, 1);
    assert.equal(logs.projects.demo.payment_failed.client.error.count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writeJsonAtomic keeps the previous file when rename is interrupted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-atomic-'));
  const path = join(directory, 'state.json');
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(path, 'previous\n');
  try {
    await assert.rejects(
      writeJsonAtomic(path, { next: true }, { rename: async () => { throw new Error('rename interrupted'); } }),
      /rename interrupted/
    );
    assert.equal(await readFile(path, 'utf8'), 'previous\n');
    await access(temporary);
    assert.deepEqual(JSON.parse(await readFile(temporary, 'utf8')), { next: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PersistenceCoordinator restart scan compacts persisted minutes through hour and day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-history-restart-'));
  const sqlitePath = join(directory, 'state.sqlite');
  const config = testServerConfig({
    persistenceFlushIntervalMs: 1,
    sqlite: { ...testServerConfig().sqlite, path: sqlitePath, maxWriteBatchRows: 2 },
    history: {
      ...testServerConfig().history,
      clockSkewAllowanceMs: 1,
      maxAcceptedPastAgeMs: 1,
      aggregateHourlyRetentionHours: 720,
      aggregateDailyRetentionDays: 365,
      compactionIntervalMs: 60_000
    }
  });
  const from = Date.UTC(2026, 7, 20);
  const row = {
    kind: 'counter', name: 'requests', role: 'api', environment: 'production', appVersion: '1.0.0',
    dimensions: null, value: 4
  };
  let store = new SqliteStateStore({ path: sqlitePath, settings: sqliteSettings(config) });
  store.saveBuckets('minute', [
    { project: 'demo', tier: 'minute', from, to: from + 60_000, finalized: true, dropCount: 0, rows: [row] },
    {
      project: 'demo', tier: 'minute', from: from + 60_000, to: from + 120_000,
      finalized: true, dropCount: 0, rows: [{ ...row, value: 6 }]
    }
  ]);
  store.close();

  store = new SqliteStateStore({ path: sqlitePath, settings: sqliteSettings(config) });
  const coordinator = new PersistenceCoordinator({
    config,
    registry: new ProjectRegistry(config),
    diagnostics,
    stateStore: store
  });
  try {
    await coordinator.flush();
    assert.equal(store.readBucket('demo', 'hour', from).rows[0].value, 10);
    assert.equal(store.readBucket('demo', 'hour', from).finalized, true);
    assert.equal(store.readBucket('demo', 'day', from).rows[0].value, 10);
    assert.equal(store.readBucket('demo', 'day', from).finalized, true);
    assert.equal(store.readWatermark('demo', 'minute', 'hour'), from + 3_600_000);
    assert.equal(store.readWatermark('demo', 'hour', 'day'), from + 86_400_000);
    assert.equal(coordinator.snapshotMetrics().historyCompactions, 2);
  } finally {
    await coordinator.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
