import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConcurrencyGate, QueuedConcurrencyGate } from '../src/capacity/ConcurrencyGate.js';

test('ConcurrencyGate rejects above its bound and recovers after release', () => {
  const gate = new ConcurrencyGate(2);
  const first = gate.enter();
  const second = gate.enter();
  assert.equal(typeof first, 'function');
  assert.equal(typeof second, 'function');
  assert.equal(gate.enter(), null);
  assert.deepEqual(gate.snapshot(), { limit: 2, active: 2, peak: 2, rejected: 1 });
  first();
  const recovered = gate.enter();
  assert.equal(typeof recovered, 'function');
  second();
  recovered();
  assert.deepEqual(gate.snapshot(), { limit: 2, active: 0, peak: 2, rejected: 1 });
});

test('ConcurrencyGate rejects invalid limits and duplicate release', () => {
  assert.throws(() => new ConcurrencyGate(0), /integer >= 1/);
  const gate = new ConcurrencyGate(1);
  const leave = gate.enter();
  leave();
  assert.throws(() => leave(), /already released/);
});

test('QueuedConcurrencyGate bounds pending reads and resumes them in order', async () => {
  const gate = new QueuedConcurrencyGate(1, 1);
  const first = await gate.acquire();
  const secondPromise = gate.acquire();
  await assert.rejects(gate.acquire(), /MCP read overloaded/);
  assert.equal(gate.snapshot().pending, 1);
  first();
  const second = await secondPromise;
  assert.equal(gate.snapshot().active, 1);
  second();
  assert.deepEqual(gate.snapshot(), {
    limit: 1,
    maxPending: 1,
    active: 0,
    pending: 0,
    peakActive: 1,
    peakPending: 1,
    rejected: 1
  });
});
