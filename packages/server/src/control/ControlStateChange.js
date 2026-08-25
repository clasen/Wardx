function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function clone(value) {
  return structuredClone(value);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertControlState(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
}

function assertPath(path) {
  if (!Array.isArray(path) || path.length === 0) throw new Error('control change path is required');
  for (const segment of path) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new Error('control change path segments must be non-empty strings');
    }
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new Error(`control change path contains prohibited segment: ${segment}`);
    }
  }
}

function validateOperation(item) {
  if (!isObject(item)) throw new Error('control change operation must be an object');
  assertPath(item.path);
  if (item.operation === 'set') {
    if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
      throw new Error('control set operation value is required');
    }
    return;
  }
  if (item.operation === 'delete') return;
  throw new Error(`unknown control change operation: ${item.operation}`);
}

function collect(left, right, path, operations) {
  if (equal(left, right)) return;
  if (isObject(left) && isObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        operations.push({ operation: 'delete', path: [...path, key] });
      } else if (!Object.prototype.hasOwnProperty.call(left, key)) {
        operations.push({ operation: 'set', path: [...path, key], value: clone(right[key]) });
      } else {
        collect(left[key], right[key], [...path, key], operations);
      }
    }
    return;
  }
  operations.push({ operation: 'set', path: [...path], value: clone(right) });
}

export function diffControlState(before, after) {
  assertControlState(before, 'control state before');
  assertControlState(after, 'control state after');
  const operations = [];
  collect(before, after, [], operations);
  if (operations.length === 0) throw new Error('control mutation did not change state');
  for (const operation of operations) validateOperation(operation);
  return { operations };
}

export function applyControlStateChange(state, change) {
  assertControlState(state, 'control state');
  if (!change || !Array.isArray(change.operations)) throw new Error('control change operations are required');
  if (change.operations.length === 0) throw new Error('control change operations must not be empty');
  const next = clone(state);
  for (const item of change.operations) {
    validateOperation(item);
    let target = next;
    for (let index = 0; index < item.path.length - 1; index++) {
      const key = item.path[index];
      if (!isObject(target[key])) {
        throw new Error(`control change path does not resolve to an object: ${item.path.slice(0, index + 1).join('.')}`);
      }
      target = target[key];
    }
    const key = item.path[item.path.length - 1];
    if (item.operation === 'set') target[key] = clone(item.value);
    else delete target[key];
  }
  return next;
}
