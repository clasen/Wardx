import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HLL_MAX_RANK, HyperLogLog, rankAfterIndex } from '../src/metrics/HyperLogLog.js';
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

test('HLL numeric rank covers the entire suffix independently of the index bits', () => {
  for (const index of [0, 1, 255, 256, 511]) {
    for (let rank = 1; rank <= HLL_MAX_RANK; rank++) {
      const suffix = rank === HLL_MAX_RANK ? 0n : 1n << BigInt(HLL_MAX_RANK - rank - 1);
      const digest = BigInt(index) << 55n | suffix;
      assert.equal(rankAfterIndex(digest), rank);
    }
  }
});

test('HLL numeric extraction preserves byte-based sketches across resets and repeated identities', () => {
  for (const salt of ['test-salt', 'otro-盐']) {
    const hll = new HyperLogLog('users', null, salt);
    for (let window = 0; window < 2; window++) {
      const expected = new Uint8Array(512);
      for (let i = 0; i < 2000; i++) {
        const subject = `jugador-🃏-é-${window}-${i % 1000}`;
        const digest = Buffer.from(subjectHash(salt, subject), 'hex');
        const index = digest[0] << 1 | digest[1] >> 7;
        let rank = 1;
        for (let bit = 9; bit < 64; bit++) {
          if ((digest[bit >> 3] & (1 << (7 - (bit & 7)))) !== 0) break;
          rank++;
        }
        expected[index] = Math.max(expected[index], rank);
        hll.add(subject);
      }
      assert.deepEqual(hll.registers, expected);
      hll.reset();
    }
  }
});
