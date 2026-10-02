import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { gzipEnvelope, gunzipBuffer } from '../src/compression/gzip.js';

test('streamed gzip yields while compressing a large envelope', async () => {
  const payload = randomBytes(4 * 1024 * 1024).toString('base64');
  const frames = [{ payload }];
  const pending = gzipEnvelope({ protocol: 1 }, frames.map((frame) => JSON.stringify(frame)));
  assert.ok(pending instanceof Promise);
  const first = await Promise.race([
    pending.then(() => 'compressed'),
    setImmediate('event-loop')
  ]);
  assert.equal(first, 'event-loop');
  const encoded = await pending;
  assert.deepEqual(JSON.parse(gunzipBuffer(encoded.compressed)), { protocol: 1, frames });
});

test('streamed envelopes preserve cached JSON, UTF-8 byte counts and empty batches', async () => {
  const metadata = { protocol: 1, client: { attributes: { text: '東京 🧪' } } };
  for (const frames of [[], [{ seq: 1, events: [[1, 'é', { text: '"\\\n' }]] }], [{ seq: 1 }, { seq: 2 }]]) {
    const encoded = await gzipEnvelope(metadata, frames.map((frame) => JSON.stringify(frame)));
    const body = gunzipBuffer(encoded.compressed);
    assert.equal(body.toString(), JSON.stringify({ ...metadata, frames }));
    assert.equal(encoded.bytesUncompressed, body.length);
  }
  await assert.rejects(gzipEnvelope(metadata, [undefined]), /string|Buffer/);
  assert.deepEqual(JSON.parse(gunzipBuffer((await gzipEnvelope(metadata, [])).compressed)), { ...metadata, frames: [] });
});

test('metadata encoding errors do not poison later envelopes', async () => {
  const metadata = {};
  metadata.self = metadata;
  await assert.rejects(gzipEnvelope(metadata, []), /circular/i);
  const encoded = await gzipEnvelope({ protocol: 1 }, []);
  assert.deepEqual(JSON.parse(gunzipBuffer(encoded.compressed)), { protocol: 1, frames: [] });
});
