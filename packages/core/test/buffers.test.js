import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBuffer } from '../src/buffers/EventBuffer.js';
import { LogBuffer } from '../src/buffers/LogBuffer.js';

test('event buffer drops when full', () => {
  const buf = new EventBuffer(2);
  assert.equal(buf.push('a', null), true);
  assert.equal(buf.push('b', null), true);
  assert.equal(buf.push('c', null), false);
  const sealed = buf.swap();
  assert.equal(sealed.length, 2);
  assert.equal(buf.length, 0);
});

test('log buffer keeps higher priority entries under pressure', () => {
  const buf = new LogBuffer(2);
  assert.equal(buf.push('debug', 'd1'), true);
  assert.equal(buf.push('info', 'i1'), true);
  assert.equal(buf.push('error', 'e1'), false);
  const sealed = buf.swap();
  const messages = sealed.map((row) => row[2]).sort();
  assert.deepEqual(messages, ['e1', 'i1']);
});

test('log buffer drops incoming debug when full of errors', () => {
  const buf = new LogBuffer(1);
  assert.equal(buf.push('error', 'e1'), true);
  assert.equal(buf.push('debug', 'd1'), false);
  assert.equal(buf.swap()[0][2], 'e1');
});
