import { gzipSync, gunzipSync } from 'node:zlib';

export function gzipBuffer(input) {
  return gzipSync(input);
}

export function gunzipBuffer(input) {
  return gunzipSync(input);
}
