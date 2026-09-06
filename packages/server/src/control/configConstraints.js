export const CONFIG_CONSTRAINT_SCHEMA = {
  type: 'object',
  description: 'Optional server-only Remote Config contract. Bounds are inclusive and numeric only; enum accepts scalar values of the declared type.',
  properties: {
    type: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] },
    min: { type: 'number' },
    max: { type: 'number' },
    enum: { type: 'array', minItems: 1, uniqueItems: true, items: { type: ['string', 'number', 'boolean', 'null'] } }
  },
  required: ['type'],
  additionalProperties: false
};

const TYPES = new Set(CONFIG_CONSTRAINT_SCHEMA.properties.type.enum);
const KEYS = new Set(Object.keys(CONFIG_CONSTRAINT_SCHEMA.properties));

export class ConfigConstraintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigConstraintError';
    this.code = 'invalid_config_constraint';
  }
}

function fail(message) {
  throw new ConfigConstraintError(message);
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(value, constraint, label) {
  if (!matchesType(value, constraint.type)) fail(`${label} must have type ${constraint.type}`);
  if (constraint.min !== undefined && value < constraint.min) fail(`${label} must be >= ${constraint.min}`);
  if (constraint.max !== undefined && value > constraint.max) fail(`${label} must be <= ${constraint.max}`);
  if (constraint.enum !== undefined && !constraint.enum.includes(value)) fail(`${label} must be an allowed enum value`);
}

export function validateConfigConstraint(constraint, label) {
  if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) fail(`${label} must be an object`);
  for (const key of Object.keys(constraint)) {
    if (!KEYS.has(key)) fail(`${label} unknown key: ${key}`);
  }
  if (!TYPES.has(constraint.type)) fail(`${label}.type must be one of ${[...TYPES].join(', ')}`);
  for (const key of ['min', 'max']) {
    if (constraint[key] === undefined) continue;
    if (constraint.type !== 'number' && constraint.type !== 'integer') fail(`${label}.${key} requires a numeric type`);
    if (typeof constraint[key] !== 'number' || !Number.isFinite(constraint[key])) fail(`${label}.${key} must be finite`);
  }
  if (constraint.min !== undefined && constraint.max !== undefined) {
    if (constraint.min > constraint.max) fail(`${label}.min must be <= max`);
    if (constraint.type === 'integer' && Math.ceil(constraint.min) > Math.floor(constraint.max)) {
      fail(`${label} range must contain an integer`);
    }
  }
  if (constraint.enum !== undefined) {
    if (constraint.type === 'object' || constraint.type === 'array') fail(`${label}.enum requires a scalar type`);
    if (!Array.isArray(constraint.enum) || constraint.enum.length === 0) fail(`${label}.enum must be a non-empty array`);
    if (new Set(constraint.enum).size !== constraint.enum.length) fail(`${label}.enum must contain unique values`);
    for (const value of constraint.enum) validateValue(value, constraint, `${label}.enum item`);
  }
}

export function validateConfigConstraints(snapshot, catalog, label = 'config snapshot') {
  for (const [key, signal] of Object.entries(catalog?.signals ?? {})) {
    if (signal.constraint === undefined) continue;
    const constraintLabel = `${label}.catalog.signals.${key}.constraint`;
    validateConfigConstraint(signal.constraint, constraintLabel);
    if (Object.hasOwn(snapshot.values, key)) {
      validateValue(snapshot.values[key], signal.constraint, `${label}.values.${key}`);
    }
    for (const experiment of snapshot.experiments) {
      for (const variant of experiment.variants) {
        if (Object.hasOwn(variant.values, key)) {
          validateValue(variant.values[key], signal.constraint, `${label}.experiments.${experiment.id}.variants.${variant.key}.values.${key}`);
        }
      }
    }
  }
}
