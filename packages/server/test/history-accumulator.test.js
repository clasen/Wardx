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
