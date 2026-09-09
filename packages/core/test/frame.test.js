import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameBuilder } from '../src/frame/FrameBuilder.js';
import { WardxCore } from '../src/WardxCore.js';
import { testSettings } from './helpers.js';

test('pending frames stay bounded, keep recent data and drain once after saturation', () => {
  const core = new WardxCore(testSettings({ maxPendingFrames: 3 }));
  for (let i = 0; i < 100; i++) {
    core.event(`event.${i}`);
    core.snapshotFrame();
    assert.ok(core.pendingFrames.length <= 3);
  }
  const pending = core.takePendingFrames();
  assert.deepEqual(pending.map((frame) => frame.seq), [98, 99, 100]);
  assert.deepEqual(pending.flatMap((frame) => frame.events.map((row) => row[1])),
    ['event.97', 'event.98', 'event.99']);
  assert.equal(core.internal.framesFailed, 1);
  assert.deepEqual(core.takePendingFrames(), []);
  core.event('recovered');
  core.snapshotFrame();
  const recovered = core.takePendingFrames();
  assert.equal(recovered[0].seq, 101);
  assert.equal(recovered[0].metrics.counters.find((row) => row[0] === 'wardx.internal.frames_failed')[2], 1);
});

test('a split batch larger than capacity retains only its newest physical frames', () => {
  const core = new WardxCore(testSettings({ maxPendingFrames: 2, maxFrameBytes: 1024 }));
  core.event('old');
  core.snapshotFrame();
  for (let i = 0; i < 100; i++) core.event(`event.${i}`, { pad: 'x'.repeat(100) });
  const batch = core.snapshotFrame();
  assert.ok(batch.frames.length > 2);
  assert.deepEqual(core.takePendingFrames(), batch.frames.slice(-2));
  assert.equal(core.internal.framesFailed, 1 + batch.frames.length - 2);
});

test('snapshot swaps buffers so new writes land on the active buffer', () => {
  const core = new WardxCore(testSettings({ maxBufferedEvents: 10 }));
  core.counter('n').add(4);
  core.event('a', { k: 1 });
  const first = core.snapshotFrame();
  core.event('b', { k: 2 });
  const second = core.snapshotFrame();
  assert.equal(first.frames.flatMap((frame) => frame.events).length, 1);
  assert.equal(first.frames.flatMap((frame) => frame.events)[0][1], 'a');
  assert.equal(second.frames.flatMap((frame) => frame.events).length, 1);
  assert.equal(second.frames.flatMap((frame) => frame.events)[0][1], 'b');
  const counter = first.frames.flatMap((frame) => frame.metrics.counters).find((row) => row[0] === 'n');
  assert.equal(counter[2], 4);
});

test('seq increases monotonically', () => {
  const core = new WardxCore(testSettings());
  core.event('a');
  const a = core.snapshotFrame();
  core.event('b');
  const b = core.snapshotFrame();
  assert.equal(a.frames.at(-1).seq + 1, b.frames[0].seq);
});

test('internal dropped counters are merged into the next frame without recursion', () => {
  const core = new WardxCore(testSettings({ maxBufferedEvents: 1 }));
  core.event('keep');
  core.event('drop-me');
  const fitted = core.snapshotFrame();
  const dropped = fitted.frames.flatMap((frame) => frame.metrics.counters)
    .find((row) => row[0] === 'wardx.internal.events_dropped');
  assert.equal(dropped[2], 1);
});

function bareFrame({ events = [], logs = [], histograms = [], gauges = [], distincts = [] }) {
  return {
    seq: 1,
    from: 1,
    to: 2,
    metrics: { counters: [], gauges, histograms, distincts },
    events,
    logs
  };
}

test('splitToMaxBytes keeps an HLL row under the minimum frame size', () => {
  const core = new WardxCore(testSettings({ maxFrameBytes: 1024 }));
  core.distinct('shot.traffic.hids', { result: 'violating' }).add('private-hid');
  const batch = core.snapshotFrame();
  assert.equal(batch.droppedDistincts, 0);
  assert.equal(batch.frames.flatMap((frame) => frame.metrics.distincts || []).length, 1);
  assert.ok(batch.jsons.every((json) => Buffer.byteLength(json, 'utf8') <= 1024));
  assert.doesNotMatch(batch.jsons.join(''), /private-hid/);
});

test('splitToMaxBytes keeps a frame that already fits', () => {
  const frame = bareFrame({ events: [[1, 'a', null]] });
  const batch = FrameBuilder.splitToMaxBytes(frame, 4096);
  assert.equal(batch.droppedRows, 0);
  assert.equal(batch.frames.length, 1);
  assert.equal(batch.frames[0].events.length, 1);
  assert.ok(Buffer.byteLength(batch.jsons[0], 'utf8') <= 4096);
});

test('splitToMaxBytes preserves all splittable events in consecutive frames', () => {
  const events = [];
  for (let i = 0; i < 200; i++) events.push([i, 'e', { pad: 'y'.repeat(80) }]);
  const batch = FrameBuilder.splitToMaxBytes(bareFrame({ events }), 4096);
  assert.ok(batch.frames.length > 1);
  assert.equal(batch.droppedRows, 0);
  assert.deepEqual(batch.frames.flatMap((frame) => frame.events), events);
  assert.deepEqual(batch.frames.map((frame) => frame.seq), [...batch.frames.keys()].map((i) => i + 1));
  assert.ok(batch.jsons.every((json) => Buffer.byteLength(json, 'utf8') <= 4096));
});

test('splitToMaxBytes drops only an indivisible row and reports it in-band', () => {
  const huge = ['x'.repeat(3000), null, 1];
  const frame = bareFrame({});
  frame.metrics.counters = [['kept', null, 2], huge];
  const batch = FrameBuilder.splitToMaxBytes(frame, 1024);
  assert.equal(batch.droppedRows, 1);
  assert.equal(batch.droppedCounters, 1);
  const counters = batch.frames.flatMap((physical) => physical.metrics.counters);
  assert.ok(counters.some((row) => row[0] === 'kept'));
  assert.ok(counters.some((row) => row[0] === 'wardx.internal.frame_rows_dropped' && row[2] === 1));
  assert.ok(batch.jsons.every((json) => Buffer.byteLength(json, 'utf8') <= 1024));
});

test('splitToMaxBytes handles 5000 mixed rows under a 32KB cap without loss', () => {
  const events = [];
  for (let i = 0; i < 5000; i++) events.push([i, 'e', { payload: 'y'.repeat(40), i }]);
  const t0 = process.hrtime.bigint();
  const batch = FrameBuilder.splitToMaxBytes(bareFrame({ events }), 32768);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(batch.droppedRows, 0);
  assert.equal(batch.frames.flatMap((frame) => frame.events).length, 5000);
  assert.ok(batch.jsons.every((json) => Buffer.byteLength(json, 'utf8') <= 32768));
  assert.ok(ms < 1000, `expected split under 1000ms, took ${ms.toFixed(1)}ms`);
});

test('counter-only, mixed, and internal-heavy snapshots all satisfy the byte limit', () => {
  const core = new WardxCore(testSettings({ maxFrameBytes: 1024, maxSeriesPerMetric: 500 }));
  for (let i = 0; i < 150; i++) core.counter(`counter.${i}`, { lane: i }).inc();
  for (let i = 0; i < 40; i++) {
    core.gauge(`gauge.${i}`).set(i);
    core.event(`event.${i}`, { value: i });
    core.log.info(`log-${i}`, { value: i });
  }
  const batch = core.snapshotFrame();
  assert.ok(batch.frames.length > 1);
  assert.equal(batch.droppedRows, 0);
  assert.ok(batch.jsons.every((json) => Buffer.byteLength(json, 'utf8') <= 1024));
  assert.deepEqual(
    batch.frames.map((frame) => frame.seq),
    [...batch.frames.keys()].map((i) => i + 1)
  );
});

test('maxFrameBytes rejects values below the physical frame minimum', () => {
  assert.throws(() => FrameBuilder.splitToMaxBytes(bareFrame({}), 1023), /at least 1024/);
});

test('shared Node/C# maximum-size fixture has identical partitions', () => {
  const frame = bareFrame({ events: [[1, 'fixture.event', { runtime: 'shared' }]] });
  frame.seq = 7;
  frame.metrics.counters = Array.from({ length: 80 }, (_, i) => [`counter.${i}`, null, i]);
  const batch = FrameBuilder.splitToMaxBytes(frame, 1024);
  assert.deepEqual(batch.frames.map((physical) => physical.seq), [7, 8, 9]);
  assert.deepEqual(batch.frames.map((physical) => physical.metrics.counters.length), [41, 39, 0]);
  assert.deepEqual(batch.frames.map((physical) => physical.events.length), [0, 0, 1]);
  assert.deepEqual(batch.jsons.map((json) => Buffer.byteLength(json)), [1023, 997, 141]);
});
