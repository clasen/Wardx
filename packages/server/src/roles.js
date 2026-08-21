export function assertRole(value, label = 'role') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value === '*') throw new Error(`${label} cannot be *`);
}

export function assertRoles(value, label = 'roles') {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of role names`);
  }
  const seen = new Set();
  for (const role of value) {
    if (typeof role !== 'string' || role.length === 0) {
      throw new Error(`${label} must be a non-empty array of role names`);
    }
    if (role === '*') {
      if (value.length !== 1) throw new Error(`${label} cannot mix * with named roles`);
      continue;
    }
    if (seen.has(role)) throw new Error(`${label} duplicate ${role}`);
    seen.add(role);
  }
}

export function roleSees(targets, role) {
  return Array.isArray(targets) && (targets.includes('*') || targets.includes(role));
}

export function validateKeyRoles(values, keyRoles, label) {
  if (!keyRoles || typeof keyRoles !== 'object' || Array.isArray(keyRoles)) {
    throw new Error(`${label}.keyRoles must be an object`);
  }
  const valueKeys = Object.keys(values);
  const roleKeys = Object.keys(keyRoles);
  if (valueKeys.length !== roleKeys.length) {
    throw new Error(`${label}.keyRoles must list every config key`);
  }
  for (const key of valueKeys) {
    if (!Object.prototype.hasOwnProperty.call(keyRoles, key)) {
      throw new Error(`${label}.keyRoles missing ${key}`);
    }
    assertRoles(keyRoles[key], `${label}.keyRoles.${key}`);
  }
  for (const key of roleKeys) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`${label}.keyRoles extra key ${key}`);
    }
  }
}

export function valuesForRole(values, keyRoles, role) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (roleSees(keyRoles[key], role)) out[key] = value;
  }
  return out;
}

export function experimentsForRole(experiments, role) {
  return experiments.filter((experiment) => roleSees(experiment.roles, role));
}
