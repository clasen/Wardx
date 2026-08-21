import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetricsRegistry } from '../src/metrics/MetricsRegistry.js';

function registry(overrides = {}) {
  return new MetricsRegistry({
    maxSeriesPerMetric: 1000,
    maxDimensionKeys: 8,
    maxDimensionValueLength: 64,
    defaultHistogramBuckets: [10, 25, 50, 100],
    onCardinalityDropped: () => {},
    ...overrides
  });
}

test('counter inc and add accumulate in the window then reset', () => {
  const metrics = registry();
  const c = metrics.counter('match.completed');
  c.inc();
  c.inc();
  metrics.counter('coins.spent').add(50);
  const snap = metrics.snapshotAndReset();
  assert.deepEqual(snap.counters, [
    ['match.completed', null, 2],
    ['coins.spent', null, 50]
  ]);
  assert.equal(metrics.counter('match.completed').value, 0);
});

test('counter dimensions create independent series', () => {
  const metrics = registry();
  metrics.counter('match.completed', { mode: 'ranked' }).inc();
  metrics.counter('match.completed', { mode: 'casual' }).add(3);
  const snap = metrics.snapshotAndReset();
  assert.equal(snap.counters.length, 2);
  const ranked = snap.counters.find((row) => row[1].mode === 'ranked');
  const casual = snap.counters.find((row) => row[1].mode === 'casual');
  assert.equal(ranked[2], 1);
  assert.equal(casual[2], 3);
});

test('cardinality limit rejects new series without blocking', () => {
  let dropped = 0;
  const metrics = registry({
    maxSeriesPerMetric: 2,
    onCardinalityDropped: () => {
      dropped += 1;
    }
  });
  metrics.counter('q', { n: 1 }).inc();
  metrics.counter('q', { n: 2 }).inc();
  metrics.counter('q', { n: 3 }).inc();
  metrics.counter('q', { n: 3 }).inc();
  const snap = metrics.snapshotAndReset();
  assert.equal(snap.counters.length, 2);
  assert.equal(dropped, 1);
});

test('dimension key and value limits reject the series', () => {
  let dropped = 0;
  const metrics = registry({
    maxDimensionKeys: 1,
    maxDimensionValueLength: 4,
    onCardinalityDropped: () => {
      dropped += 1;
    }
  });
  metrics.counter('q', { a: 1, b: 2 }).inc();
  metrics.counter('q', { a: 'too-long' }).inc();
  metrics.counter('q', { a: 'ok' }).inc();
  const snap = metrics.snapshotAndReset();
  assert.equal(snap.counters.length, 1);
  assert.equal(dropped, 2);
});

test('gauge snapshot includes value and timestamp', () => {
  const metrics = registry();
  const before = Date.now();
  metrics.gauge('players.online').set(12492);
  const snap = metrics.snapshotAndReset();
  assert.equal(snap.gauges.length, 1);
  assert.equal(snap.gauges[0][0], 'players.online');
  assert.equal(snap.gauges[0][2], 12492);
  assert.ok(snap.gauges[0][3] >= before);
});

test('histogram records count sum min max and buckets', () => {
  const metrics = registry();
  const h = metrics.histogram('request.duration', { buckets: [10, 25, 50] });
  h.observe(3);
  h.observe(12);
  h.observe(80);
  const snap = metrics.snapshotAndReset();
  const body = snap.histograms[0][2];
  assert.equal(body.count, 3);
  assert.equal(body.sum, 95);
  assert.equal(body.min, 3);
  assert.equal(body.max, 80);
  assert.deepEqual(body.buckets, [
    [10, 1],
    [25, 1],
    [50, 0]
  ]);
  assert.equal(body.exemplar, undefined);
});

test('histogram keeps an exemplar for the window max', () => {
  const metrics = registry();
  const h = metrics.histogram('coins.award_size', { buckets: [10, 50, 100] });
  h.observe(12, { grantId: 'g-small' });
  h.observe(80, { grantId: 'g-max' });
  h.observe(40, { grantId: 'g-mid' });
  const snap = metrics.snapshotAndReset();
  const body = snap.histograms[0][2];
  assert.equal(body.max, 80);
  assert.deepEqual(body.exemplar, { value: 80, attrs: { grantId: 'g-max' } });
  h.observe(9, { grantId: 'next-window' });
  const next = metrics.snapshotAndReset();
  assert.deepEqual(next.histograms[0][2].exemplar, {
    value: 9,
    attrs: { grantId: 'next-window' }
  });
});

test('histogram exemplar follows a new max and drops when the max has no attrs', () => {
  const metrics = registry();
  const h = metrics.histogram('coins.award_size', { buckets: [10, 50, 100] });
  h.observe(20, { grantId: 'g-20' });
  h.observe(20, { grantId: 'g-20-later' });
  let body = metrics.snapshotAndReset().histograms[0][2];
  assert.deepEqual(body.exemplar, { value: 20, attrs: { grantId: 'g-20-later' } });
  h.observe(10, { grantId: 'g-10' });
  h.observe(50);
  body = metrics.snapshotAndReset().histograms[0][2];
  assert.equal(body.max, 50);
  assert.equal(body.exemplar, undefined);
});

test('histogram skips an over-limit exemplar and still records the sample', () => {
  const metrics = registry({ maxDimensionValueLength: 4 });
  const h = metrics.histogram('coins.award_size', { buckets: [10, 50] });
  h.observe(40, { grantId: 'too-long' });
  const body = metrics.snapshotAndReset().histograms[0][2];
  assert.equal(body.max, 40);
  assert.equal(body.count, 1);
  assert.equal(body.exemplar, undefined);
});

test('timer observes duration into a histogram', async () => {
  const metrics = registry();
  const end = metrics.timer('matchmaking.duration');
  await new Promise((resolve) => setTimeout(resolve, 12));
  end();
  const snap = metrics.snapshotAndReset();
  assert.equal(snap.histograms.length, 1);
  assert.equal(snap.histograms[0][0], 'matchmaking.duration');
  assert.ok(snap.histograms[0][2].min >= 1);
});
