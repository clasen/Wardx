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
    assert.equal(store.schemaVersion(), 2);
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

test('schema v1 upgrades add retention tables atomically and preserve existing project state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-upgrade-'));
  const path = join(directory, 'state.sqlite');
  let store = new SqliteStateStore({ path, settings: settings() });
  try {
    store.saveProjectState({ project: 'demo', version: 3, state: { values: { enabled: true } }, catalog: {} });
    store.database.exec(`
      DROP TABLE retention_users;
      DROP TABLE retention_projects;
      UPDATE schema_metadata SET version = 1;
      PRAGMA user_version = 1;
    `);
    const before = store.readProjectState('demo');
    store.close();
    store = new SqliteStateStore({ path, settings: settings() });
    assert.deepEqual(store.readProjectState('demo'), before);
    assert.equal(store.schemaVersion(), 2);
    store.database.prepare('INSERT INTO retention_projects VALUES (?, ?, ?)').run('demo', 'a'.repeat(64), 0);
    store.close();
    store = new SqliteStateStore({ path, settings: settings() });
    assert.deepEqual(store.readProjectState('demo'), before);
    assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM retention_projects').get().count, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SqliteStateStore rejects an incomplete schema that claims the current version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-sqlite-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path);
  database.exec('CREATE TABLE schema_metadata(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  database.exec('INSERT INTO schema_metadata VALUES (1, 1)');
  database.pragma('user_version = 1');
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
