import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { gzipBuffer, gunzipBuffer } from '../src/compression/gzip.js';

test('gzip preserves UTF-8 payloads and yields while compressing a large buffer', async () => {
  const text = JSON.stringify({ message: '温度 🧪 á', frames: [] });
  assert.equal(gunzipBuffer(await gzipBuffer(text)).toString('utf8'), text);

  const payload = randomBytes(4 * 1024 * 1024);
  const pending = gzipBuffer(payload);
  assert.ok(pending instanceof Promise);
  const first = await Promise.race([
    pending.then(() => 'compressed'),
    setImmediate('event-loop')
  ]);
  assert.equal(first, 'event-loop');
  assert.deepEqual(gunzipBuffer(await pending), payload);
});

test('gzip rejects invalid input without preventing later compression', async () => {
  await assert.rejects(gzipBuffer({}), /argument|instance/i);
  assert.equal(gunzipBuffer(await gzipBuffer('next')).toString(), 'next');
});
