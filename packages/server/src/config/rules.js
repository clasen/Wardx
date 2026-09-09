const CLIENT_FIELDS = new Set(['role', 'appVersion', 'environment', 'platform']);
const OPERATORS = new Set(['eq', 'in', 'gt', 'gte', 'lt', 'lte']);
const SCALAR = { type: ['string', 'number', 'boolean'] };

export const CONFIG_RULES_SCHEMA = {
  type: 'array',
  description: 'Ordered overrides of the base value. First matching rule wins; all conditions must match. Omit to preserve rules, or use [] to clear them.',
  items: {
    type: 'object',
    properties: {
      when: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'role, appVersion, environment, platform, or attributes.<literal attribute name>.' },
            op: { type: 'string', enum: [...OPERATORS] },
            value: { anyOf: [SCALAR, { type: 'array', minItems: 1, items: SCALAR }] }
          },
          required: ['field', 'op', 'value'], additionalProperties: false
        }
      },
      value: {}
    },
    required: ['when', 'value'], additionalProperties: false
  }
};

function scalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} unknown key: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
}

export function validateConfigRules(values, keyRules = {}, label = 'config snapshot') {
  if (!keyRules || typeof keyRules !== 'object' || Array.isArray(keyRules)) throw new Error(`${label}.keyRules must be an object`);
  for (const [key, rules] of Object.entries(keyRules)) {
    const ruleLabel = `${label}.keyRules.${key}`;
    if (!Object.hasOwn(values, key)) throw new Error(`${ruleLabel} references an unknown config key`);
    if (!Array.isArray(rules)) throw new Error(`${ruleLabel} must be an array`);
    for (const rule of rules) {
      object(rule, ['when', 'value'], ruleLabel);
      JSON.stringify(rule.value, (_key, value) => {
        if (value !== null && typeof value !== 'object' && !scalar(value)) throw new Error(`${ruleLabel}.value must contain only JSON values`);
        return value;
      });
      if (!Array.isArray(rule.when) || rule.when.length === 0) throw new Error(`${ruleLabel}.when must be a non-empty array`);
      for (const condition of rule.when) {
        object(condition, ['field', 'op', 'value'], `${ruleLabel}.when`);
        const { field, op, value } = condition;
        if (!CLIENT_FIELDS.has(field) && !(typeof field === 'string' && field.startsWith('attributes.') && field.length > 'attributes.'.length)) {
          throw new Error(`${ruleLabel} field must be client metadata or attributes.<name>`);
        }
        if (!OPERATORS.has(op)) throw new Error(`${ruleLabel} unknown operator: ${op}`);
        if (op === 'in') {
          if (!Array.isArray(value) || value.length === 0 || !value.every(scalar)) throw new Error(`${ruleLabel} in requires a non-empty scalar array`);
        } else if (op === 'eq') {
          if (!scalar(value)) throw new Error(`${ruleLabel} eq requires a scalar value`);
        } else if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`${ruleLabel} ${op} requires a finite number`);
        }
      }
    }
  }
}

function matches({ field, op, value }, client) {
  const custom = field.startsWith('attributes.');
  const source = custom ? client.attributes : client;
  const key = custom ? field.slice('attributes.'.length) : field;
  if (!source || !Object.hasOwn(source, key)) return false;
  const actual = source[key];
  if (!scalar(actual)) return false;
  if (op === 'eq') return actual === value;
  if (op === 'in') return value.includes(actual);
  if (typeof actual !== 'number') return false;
  if (op === 'gt') return actual > value;
  if (op === 'gte') return actual >= value;
  if (op === 'lt') return actual < value;
  return actual <= value;
}

export function resolveConfigRules(values, keyRules, client) {
  return Object.fromEntries(Object.entries(values).map(([key, base]) => {
    const rules = Object.hasOwn(keyRules, key) ? keyRules[key] : [];
    const rule = rules.find((candidate) => candidate.when.every((condition) => matches(condition, client)));
    return [key, rule ? rule.value : base];
  }));
}
