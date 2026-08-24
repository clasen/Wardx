import { assertRoles } from '../roles.js';

const EXPERIMENT_KEYS = new Set([
  'id',
  'enabled',
  'allocation',
  'salt',
  'roles',
  'primaryMetric',
  'goalMetric',
  'goalKind',
  'control',
  'minExposures',
  'confidence',
  'shippedVariant',
  'hypothesis',
  'variants'
]);
const VARIANT_KEYS = new Set(['key', 'weight', 'values']);

export function validateExperiment(experiment) {
  if (!experiment || typeof experiment !== 'object' || Array.isArray(experiment)) {
    throw new Error('experiment must be an object');
  }
  for (const key of Object.keys(experiment)) {
    if (!EXPERIMENT_KEYS.has(key)) throw new Error(`experiment unknown key: ${key}`);
  }
  if (typeof experiment.id !== 'string' || experiment.id.length === 0) {
    throw new Error('experiment.id is required');
  }
  if (typeof experiment.enabled !== 'boolean') {
    throw new Error('experiment.enabled must be a boolean');
  }
  if (
    typeof experiment.allocation !== 'number' ||
    !Number.isFinite(experiment.allocation) ||
    experiment.allocation < 0 ||
    experiment.allocation > 1
  ) {
    throw new Error('experiment.allocation must be a number in [0, 1]');
  }
  if (typeof experiment.salt !== 'string' || experiment.salt.length === 0) {
    throw new Error('experiment.salt is required');
  }
  assertRoles(experiment.roles, 'experiment.roles');
  if (typeof experiment.goalMetric !== 'string' || experiment.goalMetric.length === 0) {
    throw new Error('experiment.goalMetric is required');
  }
  if (experiment.primaryMetric !== undefined) {
    if (typeof experiment.primaryMetric !== 'string' || experiment.primaryMetric.length === 0) {
      throw new Error('experiment.primaryMetric must be a non-empty string');
    }
  }
  if (experiment.goalKind !== undefined) {
    if (experiment.goalKind !== 'conversion' && experiment.goalKind !== 'mean') {
      throw new Error('experiment.goalKind must be conversion or mean');
    }
  }
  if (experiment.control !== undefined) {
    if (typeof experiment.control !== 'string' || experiment.control.length === 0) {
      throw new Error('experiment.control must be a non-empty string');
    }
  }
  if (experiment.minExposures !== undefined) {
    if (!Number.isInteger(experiment.minExposures) || experiment.minExposures < 1) {
      throw new Error('experiment.minExposures must be an integer >= 1');
    }
  }
  if (experiment.confidence !== undefined) {
    if (
      typeof experiment.confidence !== 'number' ||
      !Number.isFinite(experiment.confidence) ||
      experiment.confidence <= 0 ||
      experiment.confidence >= 1
    ) {
      throw new Error('experiment.confidence must be a number in (0, 1)');
    }
  }
  if (experiment.shippedVariant !== undefined) {
    if (typeof experiment.shippedVariant !== 'string' || experiment.shippedVariant.length === 0) {
      throw new Error('experiment.shippedVariant must be a non-empty string');
    }
  }
  if (experiment.goalKind === 'mean' && experiment.minExposures !== undefined && experiment.minExposures < 2) {
    throw new Error('experiment.minExposures must be >= 2 when goalKind is mean');
  }
  if (!Array.isArray(experiment.variants) || experiment.variants.length === 0) {
    throw new Error('experiment.variants must be a non-empty array');
  }
  const keys = new Set();
  let totalWeight = 0;
  for (const variant of experiment.variants) {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
      throw new Error('experiment variant must be an object');
    }
    for (const key of Object.keys(variant)) {
      if (!VARIANT_KEYS.has(key)) throw new Error(`experiment variant unknown key: ${key}`);
    }
    if (typeof variant.key !== 'string' || variant.key.length === 0) {
      throw new Error('variant.key is required');
    }
    if (keys.has(variant.key)) {
      throw new Error(`duplicate variant key: ${variant.key}`);
    }
    keys.add(variant.key);
    if (typeof variant.weight !== 'number' || !Number.isFinite(variant.weight) || variant.weight < 0) {
      throw new Error('variant.weight must be a finite number >= 0');
    }
    totalWeight += variant.weight;
    if (!variant.values || typeof variant.values !== 'object' || Array.isArray(variant.values)) {
      throw new Error('variant.values must be an object');
    }
  }
  if (totalWeight <= 0) {
    throw new Error('experiment variant weights must sum to > 0');
  }
  if (experiment.control !== undefined && !keys.has(experiment.control)) {
    throw new Error(`experiment.control must be a variant key`);
  }
  if (experiment.shippedVariant !== undefined && !keys.has(experiment.shippedVariant)) {
    throw new Error(`experiment.shippedVariant must be a variant key`);
  }
}

function rolesOverlap(a, b) {
  if (a.includes('*') || b.includes('*')) return true;
  return a.some((role) => b.includes(role));
}

export function assertUnambiguousGoalMetrics(experiments) {
  for (let i = 0; i < experiments.length; i++) {
    const left = experiments[i];
    if (!left.enabled) continue;
    for (let j = i + 1; j < experiments.length; j++) {
      const right = experiments[j];
      if (!right.enabled || left.goalMetric !== right.goalMetric) continue;
      if (rolesOverlap(left.roles, right.roles)) {
        throw new Error(
          `enabled experiments ${left.id} and ${right.id} share goalMetric ${left.goalMetric} for overlapping roles`
        );
      }
    }
  }
}

export function toClientExperiment(experiment) {
  const out = {
    id: experiment.id,
    enabled: experiment.enabled,
    allocation: experiment.allocation,
    salt: experiment.salt,
    goalMetric: experiment.goalMetric,
    roles: [...experiment.roles],
    variants: experiment.variants.map((variant) => ({
      key: variant.key,
      weight: variant.weight,
      values: { ...variant.values }
    }))
  };
  if (experiment.primaryMetric !== undefined) out.primaryMetric = experiment.primaryMetric;
  if (experiment.goalKind !== undefined) out.goalKind = experiment.goalKind;
  if (experiment.control !== undefined) out.control = experiment.control;
  if (experiment.minExposures !== undefined) out.minExposures = experiment.minExposures;
  if (experiment.confidence !== undefined) out.confidence = experiment.confidence;
  if (experiment.shippedVariant !== undefined) out.shippedVariant = experiment.shippedVariant;
  return out;
}

export function toWireExperiment(experiment) {
  const out = toClientExperiment(experiment);
  delete out.roles;
  delete out.goalKind;
  delete out.control;
  delete out.minExposures;
  delete out.confidence;
  delete out.shippedVariant;
  return out;
}

export function assertExperimentKeysExist(experiment, values, keyRoles) {
  for (const variant of experiment.variants) {
    for (const key of Object.keys(variant.values)) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        throw new Error(`unknown config key: ${key}`);
      }
      const targets = keyRoles[key];
      for (const role of experiment.roles) {
        if (role === '*') {
          if (!targets.includes('*')) {
            throw new Error(`config key ${key} is not visible to all roles`);
          }
          continue;
        }
        if (!targets.includes('*') && !targets.includes(role)) {
          throw new Error(`config key ${key} is not visible to role ${role}`);
        }
      }
    }
  }
}
