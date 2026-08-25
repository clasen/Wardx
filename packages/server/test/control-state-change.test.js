import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyControlStateChange, diffControlState } from '../src/control/ControlStateChange.js';

test('control state diff rollback preserves unrelated intervening fields', () => {
  const before = { values: { a: 1, b: 2 }, experimentsById: {} };
  const after = { values: { a: 3, b: 2 }, experimentsById: {} };
  const forward = diffControlState(before, after);
  const inverse = diffControlState(after, before);
  assert.deepEqual(applyControlStateChange(before, forward), after);
  const intervening = { values: { a: 3, b: 9 }, experimentsById: {} };
  assert.deepEqual(applyControlStateChange(intervening, inverse), {
    values: { a: 1, b: 9 },
    experimentsById: {}
  });
});

test('control state changes reject unsafe and structurally stale paths', () => {
  assert.throws(
    () => applyControlStateChange({}, { operations: [{ operation: 'set', path: ['__proto__', 'polluted'], value: true }] }),
    /prohibited segment/
  );
  assert.equal({}.polluted, undefined);
  assert.throws(
    () => applyControlStateChange(
      { values: 'replaced by a later mutation' },
      { operations: [{ operation: 'set', path: ['values', 'a'], value: 1 }] }
    ),
    /does not resolve to an object/
  );
  assert.throws(
    () => applyControlStateChange({ values: {} }, { operations: [{ operation: 'set', path: ['values', 'a'] }] }),
    /value is required/
  );
});
