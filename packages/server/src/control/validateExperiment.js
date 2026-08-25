import { assertRoles } from '../roles.js';

const EXPERIMENT_KEYS = new Set([
  'id',
  'enabled',
  'allocation',
  'salt',
  'roles',
  'primaryMetric',
  'goalMetric',
  'assignmentUnitKind',
  'outcomeKind',
  'control',
  'targetSampleSizePerVariant',
  'earliestAnalysisAt',
  'familyWiseAlpha',
  'minimumEffect',
  'direction',
  'terminalRetentionMs',
  'healthThresholds',
  'shippedVariant',
  'hypothesis',
  'variants'
]);
const VARIANT_KEYS = new Set(['key', 'weight', 'values']);
export const FIXED_HORIZON_FIELDS = Object.freeze([
  'outcomeKind',
  'control',
  'targetSampleSizePerVariant',
  'earliestAnalysisAt',
  'familyWiseAlpha',
  'minimumEffect',
  'direction',
  'healthThresholds'
]);
export const HEALTH_THRESHOLD_FIELDS = Object.freeze([
  'maxDroppedFrames',
  'maxDuplicateExposures',
  'maxDuplicateGoals',
  'maxConflictingGoals',
  'maxVariantConflicts',
  'maxUntrustedRows',
  'maxLateRows',
  'maxMissingExposures',
  'maxImplicitExposures'
]);

export function hasFixedHorizonPlan(experiment) {
  return FIXED_HORIZON_FIELDS.some((field) => experiment[field] !== undefined);
}

function assertRequiredFixedHorizonFields(experiment) {
  for (const field of FIXED_HORIZON_FIELDS) {
    if (experiment[field] === undefined) throw new Error(`experiment.${field} is required for a fixed-horizon plan`);
  }
}

function assertHealthThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw new Error('experiment.healthThresholds must be an object');
  }
  const allowed = new Set(HEALTH_THRESHOLD_FIELDS);
  for (const field of Object.keys(thresholds)) {
    if (!allowed.has(field)) throw new Error(`experiment.healthThresholds unknown key: ${field}`);
  }
  for (const field of HEALTH_THRESHOLD_FIELDS) {
    if (thresholds[field] === undefined) throw new Error(`experiment.healthThresholds.${field} is required`);
    if (!Number.isInteger(thresholds[field]) || thresholds[field] < 0) {
      throw new Error(`experiment.healthThresholds.${field} must be an integer >= 0`);
    }
  }
}

export function assertFixedHorizonPlan(experiment, variantKeys) {
  if (!hasFixedHorizonPlan(experiment)) return false;
  assertRequiredFixedHorizonFields(experiment);
  if (experiment.outcomeKind !== 'conversion' && experiment.outcomeKind !== 'mean') {
    throw new Error('experiment.outcomeKind must be conversion or mean');
  }
  if (typeof experiment.control !== 'string' || experiment.control.length === 0) {
    throw new Error('experiment.control must be a non-empty string');
  }
  if (!Number.isInteger(experiment.targetSampleSizePerVariant) || experiment.targetSampleSizePerVariant < 1) {
    throw new Error('experiment.targetSampleSizePerVariant must be an integer >= 1');
  }
  if (experiment.outcomeKind === 'mean' && experiment.targetSampleSizePerVariant < 2) {
    throw new Error('experiment.targetSampleSizePerVariant must be >= 2 when outcomeKind is mean');
  }
  if (!Number.isInteger(experiment.earliestAnalysisAt) || experiment.earliestAnalysisAt < 0) {
    throw new Error('experiment.earliestAnalysisAt must be an integer >= 0');
  }
  if (
    typeof experiment.familyWiseAlpha !== 'number' ||
    !Number.isFinite(experiment.familyWiseAlpha) ||
    experiment.familyWiseAlpha <= 0 ||
    experiment.familyWiseAlpha >= 1
  ) {
    throw new Error('experiment.familyWiseAlpha must be a number in (0, 1)');
  }
  if (
    typeof experiment.minimumEffect !== 'number' ||
    !Number.isFinite(experiment.minimumEffect) ||
    experiment.minimumEffect < 0
  ) {
    throw new Error('experiment.minimumEffect must be a finite number >= 0');
  }
  if (!['increase', 'decrease', 'two-sided'].includes(experiment.direction)) {
    throw new Error('experiment.direction must be increase, decrease, or two-sided');
  }
  assertHealthThresholds(experiment.healthThresholds);
  if (variantKeys !== undefined) {
    if (variantKeys.size < 2) throw new Error('fixed-horizon experiment requires at least two variants');
    if (!variantKeys.has(experiment.control)) throw new Error('experiment.control must be a variant key');
  }
  return true;
}

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
  if (typeof experiment.assignmentUnitKind !== 'string' || experiment.assignmentUnitKind.length === 0) {
    throw new Error('experiment.assignmentUnitKind is required and must be a non-empty string');
  }
  if (!Number.isInteger(experiment.terminalRetentionMs) || experiment.terminalRetentionMs < 1) {
    throw new Error('experiment.terminalRetentionMs is required and must be an integer >= 1');
  }
  if (experiment.primaryMetric !== undefined) {
    if (typeof experiment.primaryMetric !== 'string' || experiment.primaryMetric.length === 0) {
      throw new Error('experiment.primaryMetric must be a non-empty string');
    }
  }
  if (experiment.shippedVariant !== undefined) {
    if (typeof experiment.shippedVariant !== 'string' || experiment.shippedVariant.length === 0) {
      throw new Error('experiment.shippedVariant must be a non-empty string');
    }
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
  assertFixedHorizonPlan(experiment, keys);
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
  out.assignmentUnitKind = experiment.assignmentUnitKind;
  out.terminalRetentionMs = experiment.terminalRetentionMs;
  for (const field of FIXED_HORIZON_FIELDS) {
    if (experiment[field] === undefined) continue;
    out[field] = field === 'healthThresholds' ? { ...experiment[field] } : experiment[field];
  }
  if (experiment.shippedVariant !== undefined) out.shippedVariant = experiment.shippedVariant;
  return out;
}

export function toWireExperiment(experiment) {
  const out = toClientExperiment(experiment);
  delete out.roles;
  delete out.assignmentUnitKind;
  delete out.terminalRetentionMs;
  for (const field of FIXED_HORIZON_FIELDS) delete out[field];
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
