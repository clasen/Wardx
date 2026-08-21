import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameBuilder } from '../src/frame/FrameBuilder.js';
import { WardxCore } from '../src/WardxCore.js';
import { testSettings } from './helpers.js';

test('snapshot swaps buffers so new writes land on the active buffer', () => {
  const core = new WardxCore(testSettings({ maxBufferedEvents: 10 }));
  core.counter('n').add(4);
  core.event('a', { k: 1 });
  const first = core.snapshotFrame();
  core.event('b', { k: 2 });
  const second = core.snapshotFrame();
  assert.equal(first.frame.events.length, 1);
  assert.equal(first.frame.events[0][1], 'a');
  assert.equal(second.frame.events.length, 1);
  assert.equal(second.frame.events[0][1], 'b');
  const counter = first.frame.metrics.counters.find((row) => row[0] === 'n');
  assert.equal(counter[2], 4);
});

test('seq increases monotonically', () => {
  const core = new WardxCore(testSettings());
  core.event('a');
  const a = core.snapshotFrame();
  core.event('b');
  const b = core.snapshotFrame();
  assert.equal(a.frame.seq + 1, b.frame.seq);
});

test('internal dropped counters are merged into the next frame without recursion', () => {
  const core = new WardxCore(testSettings({ maxBufferedEvents: 1 }));
  core.event('keep');
  core.event('drop-me');
  const fitted = core.snapshotFrame();
  const dropped = fitted.frame.metrics.counters.find((row) => row[0] === 'wardx.internal.events_dropped');
  assert.equal(dropped[2], 1);
});

function bareFrame({ events = [], logs = [], histograms = [], gauges = [] }) {
  return {
    seq: 1,
    from: 1,
    to: 2,
    metrics: { counters: [], gauges, histograms },
    events,
    logs
  };
}

test('fitToMaxBytes keeps a frame that already fits', () => {
  const frame = bareFrame({ events: [[1, 'a', null]] });
  const fitted = FrameBuilder.fitToMaxBytes(frame, 4096);
  assert.equal(fitted.droppedEvents, 0);
  assert.equal(fitted.droppedLogs, 0);
  assert.equal(fitted.frame.events.length, 1);
  assert.ok(Buffer.byteLength(fitted.json, 'utf8') <= 4096);
});

test('fitToMaxBytes drops trailing events until the json fits', () => {
  const events = [];
  for (let i = 0; i < 200; i++) events.push([i, 'e', { pad: 'y'.repeat(80) }]);
  const fitted = FrameBuilder.fitToMaxBytes(bareFrame({ events }), 4096);
  assert.ok(fitted.droppedEvents > 0);
  assert.equal(fitted.droppedEvents + fitted.frame.events.length, 200);
  assert.equal(fitted.frame.events[0][0], 0);
  assert.equal(fitted.frame.events.at(-1)[0], 200 - fitted.droppedEvents - 1);
  assert.ok(Buffer.byteLength(fitted.json, 'utf8') <= 4096);
});

test('fitToMaxBytes drops debug logs before error logs', () => {
  const logs = [
    [1, 'error', 'keep-error', { pad: 'x'.repeat(40) }],
    [2, 'debug', 'drop-debug', { pad: 'x'.repeat(40) }],
    [3, 'error', 'keep-error-2', { pad: 'x'.repeat(40) }]
  ];
  const frame = bareFrame({ logs });
  const full = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  const fitted = FrameBuilder.fitToMaxBytes(frame, full - 10);
  assert.equal(fitted.droppedLogs, 1);
  assert.deepEqual(
    fitted.frame.logs.map((row) => row[2]),
    ['keep-error', 'keep-error-2']
  );
  assert.ok(Buffer.byteLength(fitted.json, 'utf8') <= full - 10);
});

test('fitToMaxBytes trims 5000 events under a 32KB cap without dropping the prefix order', () => {
  const events = [];
  for (let i = 0; i < 5000; i++) events.push([i, 'e', { payload: 'y'.repeat(40), i }]);
  const t0 = process.hrtime.bigint();
  const fitted = FrameBuilder.fitToMaxBytes(bareFrame({ events }), 32768);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(fitted.droppedEvents > 0);
  assert.equal(fitted.droppedEvents + fitted.frame.events.length, 5000);
  assert.ok(Buffer.byteLength(fitted.json, 'utf8') <= 32768);
  assert.ok(ms < 250, `expected fit under 250ms, took ${ms.toFixed(1)}ms`);
});
