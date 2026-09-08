import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HyperLogLog } from '../src/metrics/HyperLogLog.js';
import { test } from 'node:test';
import { fnv1a32, subjectHash } from '../src/config/hash.js';

test('FNV-1a 32-bit empty string', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
});

test('subject identity uses 64 bits and separates a known FNV-1a collision', () => {
  assert.equal(fnv1a32('costarring'), fnv1a32('liquid'));
  const first = subjectHash('test-salt', 'costarring');
  const second = subjectHash('test-salt', 'liquid');
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.notEqual(first, second);
});

test('FNV-1a 32-bit a', () => {
  assert.equal(fnv1a32('a'), 0xe40c292c);
});

test('FNV-1a 32-bit foobar', () => {
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
});

test('FNV-1a 32-bit hashes UTF-8 bytes not UTF-16 code units', () => {
  const viaString = fnv1a32('é');
  const viaBytes = fnv1a32(new Uint8Array([0xc3, 0xa9]));
  assert.equal(viaString, viaBytes);
  assert.notEqual(viaString, fnv1a32(new Uint8Array([0xe9])));
});

const vectors = JSON.parse(readFileSync(new URL('./fixtures/xxhash64.json', import.meta.url), 'utf8'));

test('subject hashes and HLL registers match shared XXHash64 vectors', () => {
  for (const { salt, subject, hash, index, rank } of vectors.subjects) {
    assert.equal(subjectHash(salt, subject), hash);
    if (!salt || !subject) continue;
    const hll = new HyperLogLog('users', null, salt);
    hll.add(subject);
    hll.add(subject);
    const expected = new Uint8Array(512);
    expected[index] = rank;
    assert.deepEqual(hll.registers, expected);
  }
});
