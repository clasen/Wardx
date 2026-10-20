import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWardx } from 'wardx';
import { subjectHash } from '@wardx/core';
import { RetentionInputError, RetentionLedger } from '../src/storage/RetentionLedger.js';
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

function touch(user, day, channel) {
  return { ...activity(user, day), channel };
}

function conversion(user, day, goal = 'purchase') {
  return { ...activity(user, day), goal };
}

function horizons(status, users, total) {
  return [1, 7, 30].map((day, index) => ({
    day, status, users: status === 'mature' ? users[index] : null,
    rate: status === 'mature' ? users[index] / total : null
  }));
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

test('capacity drops only new subjects; identity salt and query limits reject without cohort eviction', () => {
  const store = openStore(testServerConfig().sqlite.path);
  try {
    const ledger = new RetentionLedger({ store, settings: { maxUsersPerProject: 1, maxQueryDays: 31 } });
    assert.equal(ledger.ingestBatch('demo', [activity('a', 0), activity('b', 0)]).activity, 1);
    assert.equal(ledger.query('demo', RANGE).cohorts[0].users, 1);
    assert.throws(() => ledger.ingestBatch('demo', [activity('a', 7), activity('a', 0, 'changed')]), /PrivacySalt/);
    assert.equal(ledger.query('demo', RANGE, START + 40 * DAY).cohorts[0].returns[1].users, 0);
    assert.equal(ledger.ingestBatch('demo', [activity('b', 30), activity('a', 30)]).activity, 1);
    assert.equal(ledger.query('demo', RANGE, START + 40 * DAY).cohorts[0].returns[2].users, 1);
    for (const range of [
      { from: '2026-02-30', to: '2026-03-02' }, { from: 'bad', to: '2026-01-02' },
      { from: '2026-01-01', to: '2026-01-01' }, { from: '2026-01-01', to: '2026-02-02' }
    ]) assert.throws(() => ledger.query('demo', range));
  } finally {
    store.close();
  }
});

test('first-touch channel is the earliest channel-bearing activity in any arrival order', () => {
  const store = openStore(testServerConfig().sqlite.path);
  try {
    const ledger = new RetentionLedger({ store, settings: { ...LIMITS, maxChannelsPerProject: 8, maxGoalsPerProject: 8 } });
    const sameInstant = [touch('tie', 0, 'meta'), touch('tie', 0, 'google')];
    const events = [
      activity('late', 0), touch('late', 1, 'tiktok'), touch('late', 3, 'google'),
      touch('direct', 0, 'google'), touch('direct', 2, 'tiktok'),
      activity('none', 0), activity('none', 1)
    ];
    for (const [index, order] of [events, [...events].reverse()].entries()) {
      const project = `order-${index}`;
      for (const event of order) ledger.ingestBatch(project, [event]);
      ledger.ingestBatch(project, index === 0 ? sameInstant : [...sameInstant].reverse());
    }
    const query = { ...RANGE, byChannel: true };
    const result = ledger.query('order-0', query, START + 40 * DAY);
    assert.deepEqual(ledger.query('order-1', query, START + 40 * DAY).cohorts, result.cohorts);
    assert.equal(result.attribution, 'first_touch');
    assert.deepEqual(result.cohorts.map(({ cohort, channel, users }) => ({ cohort, channel, users })), [
      { cohort: '2026-01-01', channel: null, users: 1 },
      { cohort: '2026-01-01', channel: 'google', users: 2 },
      { cohort: '2026-01-01', channel: 'tiktok', users: 1 }
    ]);
    assert.deepEqual(result.cohorts[0].returns, horizons('mature', [1, 0, 0], 1));
    const filtered = ledger.query('order-0', { ...RANGE, channel: 'tiktok' }, START + 40 * DAY);
    assert.deepEqual(filtered.cohorts, [result.cohorts[2]]);
    const total = ledger.query('order-0', RANGE, START + 40 * DAY);
    assert.equal(total.attribution, undefined);
    assert.deepEqual(total.cohorts.map(({ channel, users }) => ({ channel, users })), [{ channel: undefined, users: 4 }]);
  } finally {
    store.close();
  }
});

test('cohort conversion counts first conversions on or before D1/D7/D30 per channel', () => {
  const store = openStore(testServerConfig().sqlite.path);
  try {
    const ledger = new RetentionLedger({ store, settings: { ...LIMITS, maxChannelsPerProject: 8, maxGoalsPerProject: 8 } });
    ledger.ingestBatch('demo', [
      touch('a', 0, 'tiktok'), conversion('a', 0), conversion('a', 3),
      touch('b', 0, 'tiktok'), conversion('b', 9), conversion('b', 5), conversion('b', 6, 'trial'),
      touch('c', 0, 'google'), conversion('c', 31),
      conversion('d', 2), activity('d', 3)
    ]);
    ledger.ingestBatch('demo', [conversion('a', 0), conversion('b', 9)]);
    const now = START + 40 * DAY;
    const result = ledger.query('demo', { ...RANGE, goal: 'purchase' }, now);
    assert.equal(result.goal, 'purchase');
    assert.equal(result.conversionMode, 'by_day');
    assert.deepEqual(result.cohorts.map(({ cohort, users, conversions }) => ({ cohort, users, conversions })), [
      { cohort: '2026-01-01', users: 3, conversions: horizons('mature', [1, 2, 2], 3) },
      { cohort: '2026-01-04', users: 1, conversions: horizons('mature', [1, 1, 1], 1) }
    ]);
    const byChannel = ledger.query('demo', { ...RANGE, goal: 'purchase', byChannel: true }, now).cohorts;
    assert.deepEqual(byChannel.map(({ cohort, channel, conversions }) => [cohort, channel, conversions.map((row) => row.users)]), [
      ['2026-01-01', 'google', [0, 0, 0]],
      ['2026-01-01', 'tiktok', [1, 2, 2]],
      ['2026-01-04', null, [1, 1, 1]]
    ]);
    const trial = ledger.query('demo', { ...RANGE, goal: 'trial', channel: 'tiktok' }, now).cohorts[0];
    assert.deepEqual(trial.conversions, horizons('mature', [0, 1, 1], 2));
    const early = ledger.query('demo', { ...RANGE, goal: 'purchase' }, START + 7 * DAY).cohorts[0];
    assert.deepEqual(early.conversions, [
      { day: 1, status: 'mature', users: 1, rate: 1 / 3 },
      { day: 7, status: 'pending', users: null, rate: null },
      { day: 30, status: 'pending', users: null, rate: null }
    ]);
    assert.equal(ledger.query('demo', { ...RANGE, goal: 'unknown' }, now).cohorts[0].conversions[2].users, 0);
    assert.equal(ledger.query('demo', RANGE, now).cohorts[0].conversions, undefined);
    assert.equal(JSON.stringify(result).includes(activity('a', 0).subject), false);
  } finally {
    store.close();
  }
});

test('channel, goal and user caps drop labels or new subjects without evicting known state', () => {
  const store = openStore(testServerConfig().sqlite.path);
  try {
    const ledger = new RetentionLedger({ store, settings: {
      maxUsersPerProject: 2, maxChannelsPerProject: 1, maxGoalsPerProject: 1, maxQueryDays: 31
    } });
    assert.deepEqual(ledger.ingestBatch('demo', [
      touch('a', 0, 'tiktok'), touch('b', 0, 'google'), conversion('a', 1), conversion('a', 1, 'trial')
    ]), { activity: 0, conversions: 1, channels: 1 });
    assert.deepEqual(ledger.query('demo', { ...RANGE, byChannel: true }).cohorts.map((row) => row.channel), [null, 'tiktok']);
    assert.deepEqual(ledger.ingestBatch('demo', [touch('b', 0, 'tiktok'), conversion('c', 1), activity('c', 1)]), {
      activity: 1, conversions: 1, channels: 0
    });
    assert.deepEqual(ledger.query('demo', { ...RANGE, byChannel: true }).cohorts.map((row) => [row.channel, row.users]), [
      ['tiktok', 2]
    ]);

    const other = new RetentionLedger({ store, settings: {
      maxUsersPerProject: 1, maxChannelsPerProject: 1, maxGoalsPerProject: 1, maxQueryDays: 31
    } });
    assert.deepEqual(other.ingestBatch('conversion-first', [conversion('x', 0), activity('y', 0), activity('x', 1)]), {
      activity: 1, conversions: 0, channels: 0
    });
    const cohorts = other.query('conversion-first', { ...RANGE, goal: 'purchase' }, START + 40 * DAY).cohorts;
    assert.deepEqual(cohorts.map(({ cohort, users }) => [cohort, users]), [['2026-01-02', 1]]);
    assert.equal(cohorts[0].conversions[0].users, 1);
    for (const filter of [{ goal: 'Purchase' }, { goal: '' }, { channel: 'has space' }, { byChannel: 'yes' }]) {
      assert.throws(() => ledger.query('demo', { ...RANGE, ...filter }), RetentionInputError);
    }
    assert.throws(() => ledger.ingestBatch('demo', [touch('a', 0, 'UPPER')]), RetentionInputError);
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
    const salted = activity('sdk-user', 0, 'different-salt');
    const mismatch = sampleEnvelope();
    mismatch.frames[0].events = [[Date.now(), 'retention.activity', { subject: salted.subject, salt: salted.salt }]];
    let response = await fetch(`${endpoint}/v1/sync`, {
      method: 'POST', headers: { 'x-wardx-key': 'test-key' }, body: JSON.stringify(mismatch)
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /PrivacySalt/);
    assert.deepEqual(executeTool(server.wardx.control, 'get_retention', args), result);

    const newUser = activity('second-user', 0);
    const atCapacity = sampleEnvelope();
    atCapacity.frames[0].events.push([Date.now(), 'retention.activity', { subject: newUser.subject, salt: newUser.salt }]);
    const accepted = server.wardx.sink.envelopes.length;
    response = await fetch(`${endpoint}/v1/sync`, {
      method: 'POST', headers: { 'x-wardx-key': 'test-key' }, body: JSON.stringify(atCapacity)
    });
    assert.equal(response.status, 200);
    assert.equal(server.wardx.sink.envelopes.length, accepted + 1);
    assert.deepEqual(executeTool(server.wardx.control, 'get_retention', args), result);
    const readiness = await (await fetch(`${endpoint}/ready`)).json();
    assert.equal(readiness.ok, true);
    assert.deepEqual(readiness.counters, {
      retentionActivityDropped: 1, retentionConversionsDropped: 0, retentionChannelsDropped: 0
    });
    await server.wardx.stop();
    server = createIngestServer(config);
    assert.deepEqual(executeTool(server.wardx.control, 'get_retention', args), result);
  } finally {
    await client.shutdown();
    await server.wardx.stop();
  }
});

test('Node SDK channels and conversions reach MCP get_retention; malformed labels are rejected', async () => {
  const config = testServerConfig();
  const server = createIngestServer(config);
  const address = await listen(server, 0, config.host);
  const endpoint = `http://${address.address}:${address.port}`;
  const client = createWardx({
    endpoint, project: 'demo', projectKey: 'test-key', role: 'client',
    appVersion: '1.0.0', environment: 'test', privacySalt: 'retention-test-salt'
  });
  try {
    client.retentionActivity('paid-user', { channel: 'tiktok' });
    client.conversion('paid-user', 'purchase');
    client.retentionActivity('organic-user');
    await client.flush();
    await client.shutdown();
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(today) + DAY).toISOString().slice(0, 10);
    const result = executeTool(server.wardx.control, 'get_retention', {
      project: 'demo', from: today, to: tomorrow, goal: 'purchase', byChannel: true
    });
    assert.deepEqual(result.cohorts.map(({ channel, users }) => [channel, users]), [[null, 1], ['tiktok', 1]]);
    assert.ok(result.cohorts.every((row) => row.conversions.every((day) => day.status === 'pending')));
    const tiktok = executeTool(server.wardx.control, 'get_retention', {
      project: 'demo', from: today, to: tomorrow, channel: 'tiktok'
    });
    assert.deepEqual(tiktok.cohorts.map((row) => row.channel), ['tiktok']);
    assert.throws(() => executeTool(server.wardx.control, 'get_retention', {
      project: 'demo', from: today, to: tomorrow, goal: 'Not A Label'
    }), /goal/);

    const hashes = activity('wire-user', 0);
    for (const [name, attrs] of [
      ['retention.activity', { ...hashes, channel: 'TikTok' }],
      ['retention.activity', { ...hashes, channel: 7 }],
      ['retention.conversion', hashes],
      ['retention.conversion', { ...hashes, goal: 'x'.repeat(65) }],
      ['retention.conversion', { ...hashes, goal: 'purchase', channel: 'tiktok' }]
    ]) {
      const envelope = sampleEnvelope();
      envelope.frames[0].events = [[Date.now(), name, attrs]];
      const response = await fetch(`${endpoint}/v1/sync`, {
        method: 'POST', headers: { 'x-wardx-key': 'test-key' }, body: JSON.stringify(envelope)
      });
      assert.equal(response.status, 400, JSON.stringify(attrs));
    }
    const readiness = await (await fetch(`${endpoint}/ready`)).json();
    assert.deepEqual(readiness.counters, {
      retentionActivityDropped: 0, retentionConversionsDropped: 0, retentionChannelsDropped: 0
    });
  } finally {
    await client.shutdown();
    await server.wardx.stop();
  }
});
