import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HistoricalCompactor, mergeHistoryBuckets, normalizeHistoricalRow, utcBucketStart } from '../src/aggregation/history/index.js';
import { SqliteStateStore } from '../src/storage/SqliteStateStore.js';
import { HyperLogLog } from '@wardx/core';

const SQLITE_SETTINGS = {
  synchronous: 'FULL', busyTimeoutMs: 1000, walAutoCheckpointPages: 100, checkpointMode: 'TRUNCATE',
  maxWriteBatch: 100, transactionTimeoutMs: 1000, maxHistoryBuckets: 200, maxHistoryRows: 1000
};

function counter(value, overrides = {}) {
  return {
    kind: 'counter', name: 'requests', role: 'api', environment: 'production', appVersion: '1.0.0',
    dimensions: { route: '/health' }, value, ...overrides
  };
}

function distinct(ids) {
  const hll = new HyperLogLog('active.hids', null, 'test-salt');
  for (const id of ids) hll.add(id);
  return {
    kind: 'distinct', name: 'active.hids', role: 'api', environment: 'production', appVersion: '1.0.0',
    dimensions: null, ...hll.snapshot()
  };
}

test('historical HLL rows merge as a union instead of summing worker estimates', () => {
  const from = Date.UTC(2026, 0, 1);
  const first = minute('demo', from, [distinct(['a', 'b'])]);
  const second = minute('demo', from + 60_000, [distinct(['b', 'c'])]);
  const merged = mergeHistoryBuckets({
    project: 'demo', tier: 'hour', from, to: from + 3_600_000,
    sourceBuckets: [first, second], finalized: true
  });
  assert.equal(merged.rows[0].kind, 'distinct');
  assert.ok(merged.rows[0].estimate >= 2 && merged.rows[0].estimate <= 4);
  assert.doesNotMatch(JSON.stringify(merged), /"a"|"b"|"c"/);
});

function minute(project, from, rows, dropCount = 0) {
  return { project, tier: 'minute', from, to: from + 60_000, finalized: true, dropCount, rows };
}

test('historical rows are privacy-whitelisted and retain required aggregate semantics', () => {
  const row = normalizeHistoricalRow({ ...counter(3), attrs: { secret: true }, exemplar: { instanceId: 'x' } });
  assert.deepEqual(row, counter(3));
  assert.doesNotMatch(JSON.stringify(row), /attrs|exemplar|instanceId|subject/i);
  assert.throws(() => normalizeHistoricalRow(counter(1, { dimensions: { subjectId: 'raw' } })), /prohibited/);

  const gauge = normalizeHistoricalRow({
    kind: 'gauge', name: 'online', role: 'api', environment: 'production', appVersion: '1.0.0', dimensions: null,
    lastValue: 7, lastTimestamp: 20, min: 2, max: 9, sampleCount: 4
  });
  assert.equal(gauge.sampleCount, 4);
});

test('tier-neutral merge is input-order independent and rejects incompatible histogram bounds', () => {
  const from = Date.UTC(2026, 0, 1);
  const histogram = (buckets, count, sum) => ({
    kind: 'histogram', name: 'latency', role: 'api', environment: 'production', appVersion: '1.0.0',
    dimensions: null, count, sum, min: 1, max: 9, buckets
  });
  const first = minute('demo', from, [counter(2), histogram([[10, 1]], 1, 9)], 1);
  const second = minute('demo', from + 60_000, [counter(3), histogram([[10, 2]], 2, 10)], 2);
  const options = { project: 'demo', tier: 'hour', from, to: from + 3_600_000, finalized: false };
  assert.deepEqual(
    mergeHistoryBuckets({ ...options, sourceBuckets: [first, second] }),
    mergeHistoryBuckets({ ...options, sourceBuckets: [second, first] })
  );
  assert.equal(mergeHistoryBuckets({ ...options, sourceBuckets: [first, second] }).dropCount, 3);
  const incompatible = minute('demo', from + 120_000, [histogram([[20, 1]], 1, 9)]);
  assert.throws(() => mergeHistoryBuckets({ ...options, sourceBuckets: [first, incompatible] }), /incompatible histogram bounds/);
});

test('UTC bucket boundaries do not depend on local daylight-saving rules', () => {
  const timestamp = Date.UTC(2026, 6, 14, 18, 42, 10);
  assert.equal(utcBucketStart(timestamp, 'hour'), Date.UTC(2026, 6, 14, 18));
  assert.equal(utcBucketStart(timestamp, 'day'), Date.UTC(2026, 6, 14));
});

test('compaction recomputes open destinations and is idempotent with an atomic watermark', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-history-'));
  const store = new SqliteStateStore({ path: join(directory, 'state.sqlite'), settings: SQLITE_SETTINGS });
  const compactor = new HistoricalCompactor(store);
  const from = Date.UTC(2026, 0, 1);
  try {
    store.saveBuckets('minute', [minute('demo', from, [counter(2)]), minute('demo', from + 60_000, [counter(3)])]);
    const first = compactor.compact({
      project: 'demo', sourceTier: 'minute', destinationTier: 'hour', destinationFrom: from, finalized: false
    });
    const repeated = compactor.compact({
      project: 'demo', sourceTier: 'minute', destinationTier: 'hour', destinationFrom: from, finalized: false
    });
    assert.deepEqual(repeated, first);
    assert.equal(first.rows[0].value, 5);
    assert.equal(store.readWatermark('demo', 'minute', 'hour'), from + 3_600_000);

    store.saveBuckets('minute', [minute('demo', from + 60_000, [counter(8)])]);
    const recomputed = compactor.compact({
      project: 'demo', sourceTier: 'minute', destinationTier: 'hour', destinationFrom: from, finalized: false
    });
    assert.equal(recomputed.rows[0].value, 10);

    compactor.compact({
      project: 'demo', sourceTier: 'minute', destinationTier: 'hour', destinationFrom: from, finalized: true
    });
    store.saveBuckets('minute', [minute('demo', from + 60_000, [counter(20)])]);
    assert.throws(
      () => compactor.compact({
        project: 'demo', sourceTier: 'minute', destinationTier: 'hour', destinationFrom: from, finalized: true
      }),
      /finalized historical buckets are immutable/
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
