import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { createIngestServer, listen } from '../src/server.js';
import { validateServerConfig } from '../src/loadConfig.js';
import { testServerConfig } from './helpers.js';

async function start(t, overrides = {}) {
  const server = createIngestServer(testServerConfig(overrides));
  t.after(() => server.wardx.stop());
  const address = await listen(server, 0, '127.0.0.1');
  const endpoint = `http://127.0.0.1:${address.port}`;
  return { server, endpoint, ...server.wardx };
}

test('readiness probes SQLite write capability and recovers without changing application state', async (t) => {
  const { endpoint, stateStore, health, control } = await start(t);
  const before = control.getConfig('demo');
  const journal = control.listConfigChanges('demo');
  let response = await fetch(`${endpoint}/ready`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    checks: { running: true, sqlite: true, persistence: true, capacity: true, mcp: true }
  });

  stateStore.database.pragma('query_only = ON');
  health.probe();
  response = await fetch(`${endpoint}/ready`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.sqlite, false);
  assert.equal((await fetch(`${endpoint}/health`)).status, 200);

  stateStore.database.pragma('query_only = OFF');
  health.probe();
  assert.equal((await fetch(`${endpoint}/ready`)).status, 200);
  assert.deepEqual(control.getConfig('demo'), before);
  assert.deepEqual(control.listConfigChanges('demo'), journal);
  assert.equal(stateStore.schemaVersion(), 1);
});

test('SQLite probe reports writer contention and restores the normal busy timeout', async (t) => {
  const { config, health, stateStore } = await start(t);
  const writer = new Database(config.sqlite.path);
  try {
    writer.exec('BEGIN IMMEDIATE');
    health.probe();
    assert.equal(health.snapshot().checks.sqlite, false);
    assert.equal(stateStore.database.pragma('busy_timeout', { simple: true }), config.sqlite.busyTimeoutMs);
    writer.exec('ROLLBACK');
    health.probe();
    assert.equal(health.snapshot().checks.sqlite, true);
  } finally {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    writer.close();
  }
});

test('SQLite probe commits a WAL write while preserving the schema metadata', async (t) => {
  const { config, stateStore } = await start(t);
  const database = stateStore.database;
  database.pragma('wal_autocheckpoint = 0');
  database.pragma('wal_checkpoint(TRUNCATE)');
  const walPath = `${config.sqlite.path}-wal`;
  const before = statSync(walPath).size;
  stateStore.probeWritable(config.readiness.probeTimeoutMs);
  assert.ok(statSync(walPath).size > before);
  assert.equal(database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get().version, stateStore.schemaVersion());
  assert.equal(database.inTransaction, false);
});

test('SQLite probe rolls back when restoring metadata fails or updates no row', async (t) => {
  const { config, stateStore } = await start(t);
  const database = stateStore.database;
  const version = stateStore.schemaVersion();
  for (const action of ["RAISE(FAIL, 'synthetic restore failure')", 'RAISE(IGNORE)']) {
    database.exec(`
      CREATE TRIGGER fail_probe_restore BEFORE UPDATE ON schema_metadata
      WHEN OLD.version < 0 BEGIN SELECT ${action}; END
    `);
    try {
      assert.throws(() => stateStore.probeWritable(config.readiness.probeTimeoutMs), /restore/);
      assert.equal(database.prepare('SELECT version FROM schema_metadata WHERE singleton = 1').get().version, version);
      assert.equal(database.inTransaction, false);
      assert.equal(database.pragma('busy_timeout', { simple: true }), config.sqlite.busyTimeoutMs);
    } finally {
      database.exec('DROP TRIGGER fail_probe_restore');
    }
  }
  assert.doesNotThrow(() => stateStore.probeWritable(config.readiness.probeTimeoutMs));
});

test('readiness reflects persistence failure, recovery, and overdue dirty state', async (t) => {
  const { endpoint, persistence, stateStore, health, config } = await start(t);
  const finalize = stateStore.finalizeBucketsThrough;
  stateStore.finalizeBucketsThrough = () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(persistence.flush(), /synthetic disk failure/);
  const response = await fetch(`${endpoint}/ready`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.persistence, false);

  stateStore.finalizeBucketsThrough = finalize;
  await persistence.flush();
  assert.equal(health.snapshot().checks.persistence, true);
  persistence.mark('history');
  persistence.dirtySince = Date.now() - config.readiness.maxPersistenceLagMs;
  assert.equal(health.snapshot().checks.persistence, false);
  await persistence.flush();
  assert.equal(health.snapshot().ok, true);
});

test('readiness checks sync and per-project history capacity and draining', async (t) => {
  const { health, syncGate, registry, config } = await start(t, { capacity: { maxConcurrentSyncHandlers: 1 } });
  const leave = syncGate.enter();
  assert.equal(health.snapshot().checks.capacity, false);
  leave();
  assert.equal(health.snapshot().checks.capacity, true);
  const history = registry.get('demo').history;
  const projectedPending = history.projectedPending;
  history.projectedPending = () => ({ batches: config.sqlite.maxPendingBatches, bytes: 0 });
  assert.equal(health.snapshot().checks.capacity, false);
  history.projectedPending = projectedPending;
  assert.equal(health.snapshot().ok, true);
  health.stop();
  assert.equal(health.snapshot().checks.running, false);
  assert.equal(health.snapshot().ok, false);
});

test('readiness requires an available MCP HTTP listener when configured', async (t) => {
  const { health, server } = await start(t, {
    mcpHttp: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      bearerTokenEnvironmentVariable: 'WARDX_READINESS_TEST_TOKEN',
      maxRequestBytes: 65536,
      maxConcurrentRequests: 2,
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: ['http://127.0.0.1']
    }
  });
  assert.equal(health.snapshot().checks.mcp, false);
  server.wardx.mcpHttp = { isReady: () => true };
  assert.equal(health.snapshot().checks.mcp, true);
});

test('readiness policy is required, bounded, and closed-schema', () => {
  const missing = testServerConfig();
  delete missing.readiness;
  assert.throws(() => validateServerConfig(missing), /readiness/);
  for (const field of ['probeIntervalMs', 'probeTimeoutMs', 'maxPersistenceLagMs']) {
    const config = testServerConfig();
    config.readiness[field] = 0;
    assert.throws(() => validateServerConfig(config), new RegExp(`readiness.${field}`));
  }
  const extra = testServerConfig();
  extra.readiness.unused = 1;
  assert.throws(() => validateServerConfig(extra), /readiness unknown key/);
  const overflow = testServerConfig();
  overflow.readiness.probeIntervalMs = 2_147_483_648;
  assert.throws(() => validateServerConfig(overflow), /exceeds the timer range/);
});
