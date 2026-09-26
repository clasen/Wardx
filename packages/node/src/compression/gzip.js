import { promisify } from 'node:util';
import { gzip, gunzipSync } from 'node:zlib';

export const gzipBuffer = promisify(gzip);

export function gunzipBuffer(input) {
  return gunzipSync(input);
}
