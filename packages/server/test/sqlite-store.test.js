import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteStateStore } from '../src/storage/SqliteStateStore.js';

function settings(overrides = {}) {
  return {
    synchronous: 'FULL',
    busyTimeoutMs: 1000,
    walAutoCheckpointPages: 100,
    checkpointMode: 'TRUNCATE',
    maxWriteBatch: 10,
    transactionTimeoutMs: 1000,
    maxHistoryBuckets: 48,
    maxHistoryRows: 100,
    ...overrides
  };
}

function withStore(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-'));
  const path = join(directory, 'state.sqlite');
  const store = new SqliteStateStore({ path, settings: settings() });
  try {
    return fn(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('SqliteStateStore requires every operational setting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-'));
  try {
    const incomplete = settings();
    delete incomplete.maxWriteBatch;
    assert.throws(
      () => new SqliteStateStore({ path: join(directory, 'state.sqlite'), settings: incomplete }),
      /maxWriteBatch is required/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SqliteStateStore initializes the versioned WAL schema and all authoritative tables', () => {
  withStore((store) => {
    assert.equal(store.schemaVersion(), 3);
    assert.equal(store.database.pragma('journal_mode', { simple: true }), 'wal');
    assert.deepEqual(store.tableNames(), [
      'compaction_watermarks',
      'day_aggregates',
      'experiment_assignment_ledger',
      'experiment_terminal_decisions',
      'experiment_totals',
      'hour_aggregates',
      'minute_aggregates',
      'mutation_journal',
      'project_state',
      'retention_projects',
      'retention_users',
      'schema_metadata'
    ]);
  });
});

test('SqliteStateStore rejects an incompatible schema version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path);
  database.pragma('user_version = 99');
  database.close();
  try {
    assert.throws(() => new SqliteStateStore({ path, settings: settings() }), /incompatible SQLite schema version 99/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SHA-256 schema versions are rejected without modifying stored state', () => {
  for (const version of [1, 2]) {
    const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-old-hash-'));
    const path = join(directory, 'state.sqlite');
    const store = new SqliteStateStore({ path, settings: settings() });
    store.saveProjectState({ project: 'demo', version: 3, state: { values: { enabled: true } }, catalog: {} });
    store.database.exec(`UPDATE schema_metadata SET version = ${version}; PRAGMA user_version = ${version};`);
    const before = store.database.prepare('SELECT * FROM project_state').all();
    store.close();
    try {
      assert.throws(() => new SqliteStateStore({ path, settings: settings() }), /XXHash64 requires a fresh database/);
      const database = new Database(path);
      try {
        assert.equal(database.pragma('user_version', { simple: true }), version);
        assert.deepEqual(database.prepare('SELECT * FROM project_state').all(), before);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('SqliteStateStore rejects an incomplete schema that claims the current version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path);
  database.exec('CREATE TABLE schema_metadata(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  database.exec('INSERT INTO schema_metadata VALUES (1, 3)');
  database.pragma('user_version = 3');
  database.close();
  try {
    assert.throws(() => new SqliteStateStore({ path, settings: settings() }), /incompatible SQLite schema tables/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project mutation and journal entry commit atomically', () => {
  withStore((store) => {
    const result = store.commitProjectMutation({
      project: 'demo',
      previousVersion: 0,
      newVersion: 1,
      state: { values: { enabled: true } },
      catalog: { signals: {} },
      entry: { operation: 'set', reason: 'launch' },
      createdAt: 10
    });
    assert.equal(result.version, 1);
    assert.deepEqual(store.readProjectState('demo').state, { values: { enabled: true } });
    assert.deepEqual(store.listJournal('demo', { limit: 10 })[0].entry, {
      operation: 'set',
      reason: 'launch'
    });

    assert.throws(
      () =>
        store.commitProjectMutation({
          project: 'demo',
          previousVersion: 1,
          newVersion: 2,
          state: { values: { enabled: false } },
          catalog: { signals: {} },
          entry: undefined
        }),
      /entry is required/
    );
    assert.equal(store.readProjectState('demo').version, 1);
    assert.equal(store.listJournal('demo', { limit: 10 }).length, 1);
  });
});

test('bucket batches and history queries are bounded', () => {
  withStore((store) => {
    const base = Date.UTC(2026, 0, 1);
    store.saveBuckets('hour', [
      {
        project: 'demo', tier: 'hour', from: base, to: base + 3_600_000, finalized: true, dropCount: 0,
        rows: [{ kind: 'counter', name: 'requests', role: 'api', environment: 'prod', appVersion: '1', dimensions: null, value: 2 }]
      }
    ]);
    assert.equal(
      store.queryHistory({ project: 'demo', tier: 'hour', from: base, to: base + 3_600_000, limit: 1 }).length,
      1
    );
    assert.equal(
      store.queryHistory({
        project: 'demo', tier: 'hour', from: base, to: base + 3_600_000,
        role: 'api', environment: 'prod', appVersion: '1', names: ['requests'], limit: 1
      })[0].rows.length,
      1
    );
    assert.equal(
      store.queryHistory({
        project: 'demo', tier: 'hour', from: base, to: base + 3_600_000, role: 'worker', limit: 1
      })[0].rows.length,
      0
    );
    assert.throws(
      () => store.queryHistory({ project: 'demo', tier: 'hour', from: base, to: base + 3_600_000, limit: 101 }),
      /exceeds configured maximum/
    );
    assert.throws(
      () => store.queryHistory({ project: 'demo', tier: 'hour', from: base, to: base + 49 * 3_600_000, limit: 1 }),
      /range exceeds configured bucket maximum/
    );
    assert.throws(
      () => store.queryHistory({ project: 'demo', tier: 'hour', from: base, to: base + 3_600_000, names: 'requests', limit: 1 }),
      /names must be an array/
    );
    assert.throws(() => store.saveBuckets('minute', Array.from({ length: 11 }, () => ({}))), /batch exceeds/);
  });
});

test('filtered history preserves row order, empty buckets, JSON values and matching-row limits', () => {
  withStore((store) => {
    const row = {
      kind: 'histogram', name: "latency.'雪", role: 'api', environment: 'prod', appVersion: '1',
      dimensions: { route: '/a?b="c"' }, count: 2, sum: 1.25, min: 0.25, max: 1,
      buckets: [[0.5, 1], [1, 2]]
    };
    const source = [row, { ...row, role: 'worker' }, { ...row, name: 'other' }, { ...row, appVersion: '2' }];
    store.saveBuckets('hour', [
      { project: 'demo', tier: 'hour', from: 0, to: 3_600_000, finalized: true, dropCount: 0, rows: source },
      { project: 'demo', tier: 'hour', from: 3_600_000, to: 7_200_000, finalized: true, dropCount: 0, rows: [] }
    ]);
    const args = { project: 'demo', tier: 'hour', from: 1, to: 7_200_000, limit: 100 };
    const all = store.queryHistory(args);
    for (const filter of [
      { names: [row.name] }, { role: 'api' }, { environment: 'missing' }, { appVersion: '2' },
      { names: [] }, { names: [row.name], role: 'api', environment: 'prod', appVersion: '1' }
    ]) {
      const expected = all.map((bucket) => ({ ...bucket, rows: bucket.rows.filter((value) =>
        (filter.names === undefined || filter.names.includes(value.name)) &&
        ['role', 'environment', 'appVersion'].every((field) => filter[field] === undefined || filter[field] === value[field])
      ) }));
      assert.deepEqual(store.queryHistory({ ...args, ...filter }), expected);
    }
    assert.throws(() => store.queryHistory({ ...args, names: [row.name], limit: 2 }), /row limit/);
    assert.deepEqual(store.queryHistory({ ...args, names: [row.name], role: 'api', appVersion: '1', limit: 1 })[0].rows, [row]);
  });
});

test('history seeks both time bounds while preserving overlapping hour and day buckets', () => {
  withStore((store) => {
    for (const [tier, width] of [['hour', 3_600_000], ['day', 86_400_000]]) {
      const buckets = Array.from({ length: 10 }, (_, index) => ({
        project: 'demo', tier, from: index * width, to: (index + 1) * width,
        finalized: true, dropCount: 0, rows: []
      }));
      store.saveBuckets(tier, buckets);
      for (const [from, to] of [[0, width], [width, 2 * width], [width + 1, 2 * width + 1],
        [width - 1, width], [9 * width + 1, 11 * width]]) {
        assert.deepEqual(store.queryHistory({ project: 'demo', tier, from, to, limit: 10 }),
          buckets.filter((bucket) => bucket.from < to && bucket.to > from));
      }
      const sql = [];
      const prepare = store.database.prepare.bind(store.database);
      store.database.prepare = (statement) => {
        if (statement.includes('AS aggregates')) sql.push(statement);
        return prepare(statement);
      };
      try {
        store.queryHistory({ project: 'demo', tier, from: width, to: 2 * width, limit: 10 });
      } finally {
        store.database.prepare = prepare;
      }
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql[0]}`).all('demo', width, 2 * width, width, 49);
      assert.ok(plan.some((step) => /project=\? AND bucket_from>\? AND bucket_from<\?/.test(step.detail)));
      assert.throws(() => store.saveBuckets(tier, [{ ...buckets[0], from: 1 }]), /UTC-aligned/);
      assert.throws(() => store.saveBuckets(tier, [{ ...buckets[0], to: 2 * width }]), /UTC-aligned/);
    }
  });
});

test('opening an existing database updates planner statistics without changing durability settings', () => {
  withStore((store, path) => {
    for (let offset = 0; offset < 100; offset += 10) {
      store.saveBuckets('hour', Array.from({ length: 10 }, (_, index) => ({
        project: 'demo', tier: 'hour', from: (offset + index) * 3_600_000, to: (offset + index + 1) * 3_600_000,
        finalized: true, dropCount: 0, rows: []
      })));
    }
    store.close();
    const reopened = new SqliteStateStore({ path, settings: settings() });
    try {
      const statistics = reopened.database.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'hour_aggregates'").all();
      assert.ok(statistics.length > 0);
      assert.ok(statistics.every((row) => Number(row.stat.split(' ')[0]) === 100));
      assert.equal(reopened.database.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(reopened.database.pragma('synchronous', { simple: true }), 2);
      assert.equal(reopened.database.pragma('wal_autocheckpoint', { simple: true }), 100);
      assert.equal(reopened.snapshotMetrics().optimizations, 1);
    } finally {
      reopened.close();
    }
  });
});

test('WAL samples do not checkpoint and explicit checkpoint timings account for failures', (t) => {
  withStore((store) => {
    store.database.pragma('wal_autocheckpoint = 0');
    store.checkpoint();
    store.saveProjectState({ project: 'demo', version: 1, state: { values: {} }, catalog: {} });
    const before = store.snapshotMetrics();
    assert.ok(before.wal.pendingFrames > 0);
    assert.deepEqual(store.snapshotMetrics().wal, before.wal);
    assert.equal(store.snapshotMetrics().checkpoints, before.checkpoints);
    store.checkpoint();
    const after = store.snapshotMetrics();
    assert.equal(after.wal.pendingFrames, 0);
    assert.equal(after.checkpoints, before.checkpoints + 1);
    assert.ok(after.checkpointLatencyMs.total > before.checkpointLatencyMs.total);
    t.mock.method(store.database, 'pragma', () => { throw new Error('checkpoint failed'); }, { times: 1 });
    assert.throws(() => store.checkpoint(), /checkpoint failed/);
    assert.equal(store.snapshotMetrics().checkpointFailures, 1);
    store.close();
    assert.equal(store.snapshotMetrics().wal, null);
  });
});

test('automatic checkpoints remain enabled and are not counted as explicit checkpoints', () => {
  withStore((store) => {
    store.database.pragma('wal_autocheckpoint = 1');
    store.transaction(() => store.saveProjectState({
      project: 'demo', version: 1, state: { values: { payload: 'x'.repeat(16384) } }, catalog: {}
    }));
    const metrics = store.snapshotMetrics();
    assert.ok(metrics.wal.logFrames > 0);
    assert.equal(metrics.wal.pendingFrames, 0);
    assert.equal(metrics.checkpoints, 0);
    assert.equal(metrics.checkpointLatencyMs.total, 0);
    assert.ok(metrics.transactionLatencyMs.total > 0);
  });
});

test('retention cannot delete a source before a durable finalized downstream bucket and watermark', () => {
  withStore((store) => {
    const from = Date.UTC(2026, 0, 1);
    const source = {
      project: 'demo', tier: 'minute', from, to: from + 60_000, finalized: true, dropCount: 0,
      rows: [{ kind: 'counter', name: 'requests', role: 'api', environment: 'prod', appVersion: '1', dimensions: null, value: 2 }]
    };
    store.saveBuckets('minute', [source]);
    assert.equal(store.pruneBuckets('demo', 'minute', from + 60_000), 0);
    assert.ok(store.readBucket('demo', 'minute', from));

    const downstream = {
      project: 'demo', tier: 'hour', from, to: from + 3_600_000, finalized: false, dropCount: 0,
      rows: source.rows
    };
    store.replaceCompactedBucket({
      sourceTier: 'minute', destinationTier: 'hour', bucket: downstream, sourceThrough: from + 3_600_000
    });
    assert.equal(store.pruneBuckets('demo', 'minute', from + 60_000), 0);
    assert.ok(store.readBucket('demo', 'minute', from));

    store.replaceCompactedBucket({
      sourceTier: 'minute', destinationTier: 'hour', bucket: { ...downstream, finalized: true },
      sourceThrough: from + 3_600_000
    });
    assert.equal(store.pruneBuckets('demo', 'minute', from + 60_000), 1);
    assert.equal(store.readBucket('demo', 'minute', from), null);
  });
});
