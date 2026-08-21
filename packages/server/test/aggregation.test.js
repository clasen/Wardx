import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameAggregator } from '../src/aggregation/FrameAggregator.js';
import { sampleEnvelope } from './helpers.js';

function aggregator(max = 2) {
  return new FrameAggregator({
    aggregateRetentionMinutes: 60,
    aggregateMaxSeriesPerMetric: max
  });
}

function envelopeWithCounters(rows, now = Date.now()) {
  return sampleEnvelope({
    frames: [
      {
        seq: 1,
        from: now,
        to: now + 1,
        metrics: { counters: rows, gauges: [], histograms: [] },
        events: [],
        logs: []
      }
    ]
  });
}

test('FrameAggregator rejects a missing series cap', () => {
  assert.throws(
    () => new FrameAggregator({ aggregateRetentionMinutes: 60 }),
    /aggregateMaxSeriesPerMetric must be an integer >= 1/
  );
});

test('FrameAggregator caps new series per metric name and still merges existing ones', () => {
  const agg = aggregator(2);
  const now = Date.now();
  agg.ingest(
    envelopeWithCounters(
      [
        ['by.user', { userId: 'a' }, 1],
        ['by.user', { userId: 'b' }, 1],
        ['by.user', { userId: 'c' }, 9],
        ['http.ok', { route: '/x' }, 3]
      ],
      now
    )
  );
  agg.ingest(envelopeWithCounters([['by.user', { userId: 'a' }, 4]], now));
  const windows = agg.snapshot();
  assert.equal(windows.length, 1);
  const users = windows[0].counters.filter((row) => row.name === 'by.user');
  assert.equal(users.length, 2);
  const a = users.find((row) => row.dims.userId === 'a');
  const b = users.find((row) => row.dims.userId === 'b');
  assert.equal(a.value, 5);
  assert.equal(b.value, 1);
  assert.equal(users.some((row) => row.dims.userId === 'c'), false);
  assert.equal(windows[0].cardinalityDropped, 1);
  const http = windows[0].counters.find((row) => row.name === 'http.ok');
  assert.equal(http.value, 3);
});

test('FrameAggregator caps gauges and histograms independently of counters', () => {
  const agg = aggregator(1);
  const now = Date.now();
  agg.ingest(
    sampleEnvelope({
      frames: [
        {
          seq: 1,
          from: now,
          to: now + 1,
          metrics: {
            counters: [['n', { k: '1' }, 1], ['n', { k: '2' }, 1]],
            gauges: [
              ['g', { k: '1' }, 10, now],
              ['g', { k: '2' }, 20, now]
            ],
            histograms: [
              [
                'h',
                { k: '1' },
                { count: 1, sum: 2, min: 2, max: 2, buckets: [[10, 1]] }
              ],
              [
                'h',
                { k: '2' },
                { count: 1, sum: 3, min: 3, max: 3, buckets: [[10, 1]] }
              ]
            ]
          },
          events: [],
          logs: []
        }
      ]
    })
  );
  const window = agg.snapshot()[0];
  assert.equal(window.counters.length, 1);
  assert.equal(window.gauges.length, 1);
  assert.equal(window.histograms.length, 1);
  assert.equal(window.cardinalityDropped, 3);
});

function envelopeWithHistograms(rows, now = Date.now()) {
  return sampleEnvelope({
    frames: [
      {
        seq: 1,
        from: now,
        to: now + 1,
        metrics: { counters: [], gauges: [], histograms: rows },
        events: [],
        logs: []
      }
    ]
  });
}

test('FrameAggregator keeps the histogram exemplar of the higher max', () => {
  const agg = aggregator(2);
  const now = Date.now();
  agg.ingest(
    envelopeWithHistograms(
      [
        [
          'coins.award_size',
          { source: 'match' },
          {
            count: 2,
            sum: 30,
            min: 10,
            max: 20,
            buckets: [[50, 2]],
            exemplar: { value: 20, attrs: { grantId: 'g-20' } }
          }
        ]
      ],
      now
    )
  );
  agg.ingest(
    envelopeWithHistograms(
      [
        [
          'coins.award_size',
          { source: 'match' },
          {
            count: 1,
            sum: 80,
            min: 80,
            max: 80,
            buckets: [[50, 0]],
            exemplar: { value: 80, attrs: { grantId: 'g-80' } }
          }
        ]
      ],
      now
    )
  );
  const body = agg.snapshot()[0].histograms[0].body;
  assert.equal(body.count, 3);
  assert.equal(body.max, 80);
  assert.deepEqual(body.exemplar, { value: 80, attrs: { grantId: 'g-80' } });
});

test('FrameAggregator drops a stale exemplar when a higher max has none', () => {
  const agg = aggregator(2);
  const now = Date.now();
  agg.ingest(
    envelopeWithHistograms(
      [
        [
          'h',
          null,
          {
            count: 1,
            sum: 10,
            min: 10,
            max: 10,
            buckets: [[10, 1]],
            exemplar: { value: 10, attrs: { grantId: 'old' } }
          }
        ]
      ],
      now
    )
  );
  agg.ingest(
    envelopeWithHistograms(
      [['h', null, { count: 1, sum: 50, min: 50, max: 50, buckets: [[10, 0]] }]],
      now
    )
  );
  const body = agg.snapshot()[0].histograms[0].body;
  assert.equal(body.max, 50);
  assert.equal(body.exemplar, undefined);
});
