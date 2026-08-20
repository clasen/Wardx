export function requireKeys(object, keys, label) {
  const missing = [];
  for (const key of keys) {
    if (object[key] === undefined || object[key] === null) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`${label} missing required keys: ${missing.join(', ')}`);
  }
}
