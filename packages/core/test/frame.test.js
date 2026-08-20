import assert from 'node:assert/strict';
import { test } from 'node:test';
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
