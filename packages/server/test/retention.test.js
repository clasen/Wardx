import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWardx } from 'wardx';
import { subjectHash } from '@wardx/core';
import { RetentionLedger } from '../src/storage/RetentionLedger.js';
import { SqliteStateStore } from '../src/storage/SqliteStateStore.js';
import { createIngestServer, listen } from '../src/server.js';
import { executeTool } from '../src/mcp/tools.js';
import { sampleEnvelope, testServerConfig } from './helpers.js';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const RANGE = { from: '2026-01-01', to: '2026-02-01' };
const LIMITS = { maxUsersPerProject: 100, maxQueryDays: 366 };

function activity(user, day, salt = 'retention-test-salt') {
  return {
    timestamp: START + day * DAY,
    subject: subjectHash(salt, user),
    salt: subjectHash(salt, 'wardx.retention.identity')
  };
}

function openStore(path) {
  const config = testServerConfig();
  return new SqliteStateStore({ path, settings: {
    ...config.sqlite, maxWriteBatch: 100, maxHistoryBuckets: 100, maxHistoryRows: 100
  } });
}

test('exact cohort returns survive duplicates, UTC boundaries, restart and project isolation', () => {
  const path = testServerConfig().sqlite.path;
  let store = openStore(path);
  try {
    let ledger = new RetentionLedger({ store, settings: LIMITS });
    ledger.ingestBatch('demo', [
      activity('a', 0), activity('b', 0), activity('a', 1), activity('a', 1),
      activity('a', 7), activity('b', 8), activity('b', 30), activity('a', 31)
    ]);
    ledger.ingestBatch('other', [activity('a', 7)]);
    const result = ledger.query('demo', RANGE, START + 31 * DAY);
    assert.equal(result.cohorts.length, 1);
    assert.equal(result.cohorts[0].users, 2);
    assert.deepEqual(result.cohorts[0].returns, [1, 7, 30].map((day) => ({
      day, status: 'mature', users: 1, rate: 0.5
    })));
    const pending = ledger.query('demo', RANGE, START + 30 * DAY + DAY - 1).cohorts[0].returns[2];
    assert.deepEqual(pending, { day: 30, status: 'pending', users: null, rate: null });
    assert.equal(ledger.query('other', RANGE, START + 40 * DAY).cohorts[0].cohort, '2026-01-08');
    store.close();
    store = openStore(path);
    ledger = new RetentionLedger({ store, settings: LIMITS });
    ledger.ingestBatch('demo', [activity('a', 0), activity('b', 30)]);
    assert.deepEqual(ledger.query('demo', RANGE, START + 31 * DAY), result);
    assert.equal(JSON.stringify(result).includes(activity('a', 0).subject), false);
    const midnight = activity('midnight', 1);
    ledger.ingestBatch('utc', [{ ...midnight, timestamp: midnight.timestamp - 1 }, midnight]);
    assert.equal(ledger.query('utc', RANGE, START + 2 * DAY).cohorts[0].returns[0].users, 1);
  } finally {
    store.close();
  }
});

test('out-of-order activity produces the same cohort and exact returns as chronological ingestion', () => {
  const store = openStore(testServerConfig().sqlite.path);
  try {
    const ledger = new RetentionLedger({ store, settings: LIMITS });
    const days = [0, 1, 7, 8, 29, 30, 31, 100];
    const orders = [days, [...days].reverse(), [7, 30, 100, 31, 8, 1, 29, 0]];
    for (let index = 0; index < orders.length; index++) {
      for (const day of orders[index]) ledger.ingestBatch('demo', [activity(`u${index}`, day)]);
    }
    assert.deepEqual(ledger.query('demo', RANGE, START + 101 * DAY).cohorts, [{
      cohort: '2026-01-01', users: orders.length,
      returns: [1, 7, 30].map((day) => ({ day, status: 'mature', users: orders.length, rate: 1 }))
    }]);
  } finally {
    store.close();
  }
});

test('capacity, identity salt and query limits reject without partial writes or cohort eviction', () => {
  const store = openStore(testServerConfig().sqlite.path);
  try {
    const ledger = new RetentionLedger({ store, settings: { maxUsersPerProject: 1, maxQueryDays: 31 } });
    assert.throws(() => ledger.ingestBatch('demo', [activity('a', 0), activity('b', 0)]), /capacity/);
    assert.equal(ledger.query('demo', RANGE).cohorts.length, 0);
    ledger.ingestBatch('demo', [activity('a', 0)]);
    assert.throws(() => ledger.ingestBatch('demo', [activity('a', 7), activity('a', 0, 'changed')]), /PrivacySalt/);
    assert.equal(ledger.query('demo', RANGE, START + 40 * DAY).cohorts[0].returns[1].users, 0);
    assert.throws(() => ledger.ingestBatch('demo', [activity('b', 100)]), /capacity/);
    ledger.ingestBatch('demo', [activity('a', 30)]);
    assert.equal(ledger.query('demo', RANGE, START + 40 * DAY).cohorts[0].returns[2].users, 1);
    for (const range of [
      { from: '2026-02-30', to: '2026-03-02' }, { from: 'bad', to: '2026-01-02' },
      { from: '2026-01-01', to: '2026-01-01' }, { from: '2026-01-01', to: '2026-02-02' }
    ]) assert.throws(() => ledger.query('demo', range));
  } finally {
    store.close();
  }
});

test('Node public SDK, ingest validation and MCP retention query work across server restart', async () => {
  const config = testServerConfig();
  config.retention.maxUsersPerProject = 1;
  let server = createIngestServer(config);
  const address = await listen(server, 0, config.host);
  const endpoint = `http://${address.address}:${address.port}`;
  const client = createWardx({
    endpoint, project: 'demo', projectKey: 'test-key', role: 'client',
    appVersion: '1.0.0', environment: 'test', privacySalt: 'retention-test-salt'
  });
  try {
    client.retentionActivity('sdk-user');
    client.retentionActivity('sdk-user');
    await client.flush();
    await client.shutdown();
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(today) + DAY).toISOString().slice(0, 10);
    const args = { project: 'demo', from: today, to: tomorrow };
    const result = executeTool(server.wardx.control, 'get_retention', args);
    assert.equal(result.cohorts[0].users, 1);
    assert.ok(result.cohorts[0].returns.every((row) => row.status === 'pending'));
    assert.throws(() => executeTool(server.wardx.control, 'get_retention', { ...args, project: 'unknown' }), /project/);
    for (const attrs of [null, { subject: 'raw-user', salt: 'raw-salt' }, { ...activity('x', 0), userId: 'raw' }]) {
      const envelope = sampleEnvelope();
      envelope.frames[0].events = [[Date.now(), 'retention.activity', attrs]];
      const response = await fetch(`${endpoint}/v1/sync`, {
        method: 'POST', headers: { 'x-wardx-key': 'test-key' }, body: JSON.stringify(envelope)
      });
      assert.equal(response.status, 400);
    }
    for (const [entry, status, message] of [
      [activity('sdk-user', 0, 'different-salt'), 400, /PrivacySalt/],
      [activity('second-user', 0), 503, /capacity/]
    ]) {
      const envelope = sampleEnvelope();
      envelope.frames[0].events = [[Date.now(), 'retention.activity', { subject: entry.subject, salt: entry.salt }]];
      const response = await fetch(`${endpoint}/v1/sync`, {
        method: 'POST', headers: { 'x-wardx-key': 'test-key' }, body: JSON.stringify(envelope)
      });
      assert.equal(response.status, status);
      assert.match((await response.json()).error, message);
      assert.deepEqual(executeTool(server.wardx.control, 'get_retention', args), result);
    }
    await server.wardx.stop();
    server = createIngestServer(config);
    assert.deepEqual(executeTool(server.wardx.control, 'get_retention', args), result);
  } finally {
    await client.shutdown();
    await server.wardx.stop();
  }
});
