import { createGzip, gunzipSync } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function gzipEnvelope(metadata, frameJsons) {
  const prefix = JSON.stringify({ ...metadata, frames: [] }).slice(0, -2);
  let bytesUncompressed = 0;
  function* parts() {
    yield prefix;
    for (let i = 0; i < frameJsons.length; i++) {
      if (i > 0) yield ',';
      yield frameJsons[i];
    }
    yield ']}';
  }
  function* measuredParts() {
    for (const part of parts()) {
      const bytes = Buffer.from(part);
      bytesUncompressed += bytes.length;
      yield bytes;
    }
  }
  const chunks = [];
  await pipeline(
    Readable.from(measuredParts(), { objectMode: false }),
    createGzip(),
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      }
    })
  );
  return { compressed: Buffer.concat(chunks), bytesUncompressed };
}

export function gunzipBuffer(input) {
  return gunzipSync(input);
}
