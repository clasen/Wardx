import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryAccumulator } from '../src/aggregation/history/index.js';
import { sampleEnvelope } from './helpers.js';

test('HistoryAccumulator retains environment/app version and strips attrs and exemplars', () => {
  const accumulator = new HistoryAccumulator({
    project: 'demo',
    clockSkewAllowanceMs: 1000,
    maxAppVersionsPerProjectRoleTier: 2
  });
  const envelope = sampleEnvelope();
  envelope.frames[0].metrics.histograms.push([
    'latency',
    null,
    { count: 1, sum: 4, min: 4, max: 4, buckets: [[10, 1]], exemplar: { value: 4, attrs: { id: 'x' } } }
  ]);
  accumulator.ingest(envelope, ['payment_failed']);
  const buckets = accumulator.pending(Date.now() + 120_000);
  const counter = buckets[0].rows.find((row) => row.kind === 'counter');
  assert.equal(counter.environment, 'test');
  assert.equal(counter.appVersion, '0.0.0');
  assert.doesNotMatch(JSON.stringify(buckets), /product|timeout|exemplar|instanceId/i);
  assert.equal(buckets[0].finalized, true);
  accumulator.acknowledge(buckets);
  assert.deepEqual(accumulator.pending(), []);
});

test('HistoryAccumulator keeps operating systems as separate series and accepts envelopes without os', () => {
  const accumulator = new HistoryAccumulator({
    project: 'demo',
    clockSkewAllowanceMs: 1000,
    maxAppVersionsPerProjectRoleTier: 2
  });
  accumulator.ingest(sampleEnvelope({ client: { os: 'android' } }), []);
  accumulator.ingest(sampleEnvelope({ client: { os: 'ios' } }), []);
  accumulator.ingest(sampleEnvelope({ client: { os: 'ios' } }), []);
  accumulator.ingest(sampleEnvelope(), []);
  const counters = accumulator.pending(Date.now() + 120_000)[0].rows.filter((row) => row.kind === 'counter');
  const byOs = (os) => counters.filter((row) => row.os === os);
  assert.equal(byOs('android').length, byOs('ios').length);
  assert.ok(byOs('android').length > 0);
  for (const [index, row] of byOs('ios').entries()) assert.equal(row.value, 2 * byOs('android')[index].value);
  assert.equal(byOs(undefined).length, byOs('android').length);
  assert.ok(byOs(undefined).every((row) => !Object.hasOwn(row, 'os')));
});

test('HistoryAccumulator merges repeated minute data and rejects a new over-cap app version atomically', () => {
  const accumulator = new HistoryAccumulator({
    project: 'demo',
    clockSkewAllowanceMs: 1000,
    maxAppVersionsPerProjectRoleTier: 1
  });
  const first = sampleEnvelope();
  accumulator.ingest(first, []);
  accumulator.ingest(first, []);
  const counter = accumulator.pending()[0].rows.find((row) => row.kind === 'counter');
  assert.equal(counter.value, 8);
  const before = accumulator.pending();
  const overCap = sampleEnvelope({ client: { appVersion: '2.0.0' } });
  assert.throws(() => accumulator.ingest(overCap, []), /app-version cap exceeded/);
  assert.deepEqual(accumulator.pending(), before);
});

test('HistoryAccumulator prepares only touched series while projecting the complete pending bucket', () => {
  const accumulator = new HistoryAccumulator({
    project: 'demo',
    clockSkewAllowanceMs: 1000,
    maxAppVersionsPerProjectRoleTier: 1
  });
  const first = sampleEnvelope();
  first.frames[0].metrics = {
    counters: Array.from({ length: 1000 }, (_, index) => [`metric.${index}`, null, 1]),
    gauges: [],
    histograms: []
  };
  first.frames[0].events = [];
  first.frames[0].logs = [];
  accumulator.ingest(first, []);

  const next = structuredClone(first);
  next.frames[0].metrics.counters = [['metric.500', null, 2]];
  const prepared = accumulator.prepare(next, []);
  assert.equal(prepared.updates.length, 1);
  assert.equal(prepared.updates[0].rows.length, 1);
  const projected = accumulator.projectedPending(prepared);
  assert.equal(projected.batches, 1);
  assert.ok(projected.bytes > 1000);
  accumulator.commit(prepared);
  const bucket = accumulator.pending()[0];
  assert.equal(bucket.rows.length, 1000);
  assert.equal(bucket.rows.find((row) => row.name === 'metric.500').value, 3);
});

test('HistoryAccumulator prunes only persisted minutes outside the late-arrival window', () => {
  const accumulator = new HistoryAccumulator({
    project: 'demo', clockSkewAllowanceMs: 1000, maxAppVersionsPerProjectRoleTier: 1
  });
  const envelope = sampleEnvelope();
  for (let minute = 0; minute < 1440; minute++) {
    envelope.frames[0].from = minute * 60_000;
    accumulator.ingest(envelope, []);
    accumulator.acknowledge(accumulator.pending());
    accumulator.prunePersisted((minute - 60) * 60_000);
    assert.ok(accumulator.states.size <= 61);
  }
  const from = envelope.frames[0].from;
  accumulator.prunePersisted(from + 59_999);
  accumulator.ingest(envelope, []);
  assert.equal(accumulator.pending()[0].rows.find((row) => row.kind === 'counter').value, 8);
  accumulator.prunePersisted(from + 60_000);
  assert.equal(accumulator.states.size, 1);
  accumulator.acknowledge(accumulator.pending());
  accumulator.prunePersisted(from + 60_000);
  assert.equal(accumulator.states.size, 0);
});

test('HistoryAccumulator tracks merged bucket bytes exactly as their JSON encoding', () => {
  const accumulator = new HistoryAccumulator({
    project: 'demo', clockSkewAllowanceMs: 300_000, maxAppVersionsPerProjectRoleTier: 1
  });
  const hll = (step) => {
    const registers = Buffer.alloc(512);
    for (let index = 0; index <= step * 37; index++) registers[index % 512] = 1 + (index % 7);
    return { precision: 9, registers: registers.toString('base64') };
  };
  for (let step = 0; step < 12; step++) {
    const envelope = sampleEnvelope();
    const frame = envelope.frames[0];
    frame.metrics = {
      counters: [['grows', null, 9], ['grows', null, 0.1], ['signed', { mode: 'ranked' }, -7 * step]],
      gauges: [['temperature', null, step % 2 ? -0.3 * step : 1e21 * step, frame.to - step]],
      histograms: [['latency', null, { count: step + 1, sum: 0.1 * step, min: -1, max: 99.5, buckets: [[10, step], [100, 1]] }]],
      distincts: [['players', null, hll(step)]]
    };
    frame.events = Array.from({ length: 9 }, () => [frame.from + 1, 'purchase', {}]);
    frame.logs = [[frame.from + 2, 'error', 'payment_failed', {}]];
    accumulator.ingest(envelope, ['payment_failed']);
    const [bucket] = accumulator.pending();
    assert.equal(bucket.finalized, false);
    assert.equal(accumulator.projectedPending({ updates: [] }).bytes, Buffer.byteLength(JSON.stringify(bucket)));
  }
});
