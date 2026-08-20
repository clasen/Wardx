export function dimKey(dims) {
  if (dims == null) return '';
  const keys = Object.keys(dims);
  const n = keys.length;
  if (n === 0) return '';
  if (n === 1) return keys[0] + '=' + String(dims[keys[0]]);
  keys.sort();
  let out = keys[0] + '=' + String(dims[keys[0]]);
  for (let i = 1; i < n; i++) {
    out += '\n' + keys[i] + '=' + String(dims[keys[i]]);
  }
  return out;
}

export function validateDimensions(dims, maxDimensionKeys, maxDimensionValueLength) {
  if (dims == null) return { ok: true, dims: null };
  if (typeof dims !== 'object' || Array.isArray(dims)) {
    throw new Error('dimensions must be a plain object');
  }
  const keys = Object.keys(dims);
  if (keys.length === 0) return { ok: true, dims: null };
  if (keys.length > maxDimensionKeys) {
    return { ok: false, reason: 'maxDimensionKeys' };
  }
  for (let i = 0; i < keys.length; i++) {
    const value = dims[keys[i]];
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new Error(`dimension ${keys[i]} must be string, number, or boolean`);
    }
    if (String(value).length > maxDimensionValueLength) {
      return { ok: false, reason: 'maxDimensionValueLength' };
    }
  }
  return { ok: true, dims };
}

export function assertMetricName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('metric name must be a non-empty string');
  }
}
