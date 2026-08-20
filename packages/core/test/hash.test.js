import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fnv1a32 } from '../src/config/hash.js';

test('FNV-1a 32-bit empty string', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
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
