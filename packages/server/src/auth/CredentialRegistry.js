const CREDENTIAL_FIELDS = new Set([
  'project',
  'label',
  'allowedRoles',
  'trustedForDecisions',
  'enabled'
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateAllowedRoles(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of role names`);
  }
  const seen = new Set();
  for (const role of value) {
    assertNonEmptyString(role, `${label} role`);
    if (role === '*') throw new Error(`${label} cannot contain *`);
    if (seen.has(role)) throw new Error(`${label} duplicate role: ${role}`);
    seen.add(role);
  }
  return [...seen];
}

function validateRecord(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of CREDENTIAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new Error(`${label}.${field} is required`);
    }
  }
  for (const field of Object.keys(record)) {
    if (!CREDENTIAL_FIELDS.has(field)) throw new Error(`${label} unknown key: ${field}`);
  }
  assertNonEmptyString(record.project, `${label}.project`);
  assertNonEmptyString(record.label, `${label}.label`);
  const allowedRoles = validateAllowedRoles(record.allowedRoles, `${label}.allowedRoles`);
  if (typeof record.trustedForDecisions !== 'boolean') {
    throw new Error(`${label}.trustedForDecisions must be a boolean`);
  }
  if (typeof record.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`);
  }
  return Object.freeze({
    project: record.project,
    label: record.label,
    allowedRoles: Object.freeze(allowedRoles),
    trustedForDecisions: record.trustedForDecisions,
    enabled: record.enabled
  });
}

export class CredentialAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialAuthorizationError';
    this.code = code;
  }
}

export class CredentialRegistry {
  constructor(records) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
      throw new Error('credentials must be an object keyed by credential value');
    }
    this.records = new Map();
    const labels = new Set();
    for (const [credential, input] of Object.entries(records)) {
      assertNonEmptyString(credential, 'credential');
      const record = validateRecord(input, `credentials.${input?.label || '<unlabeled>'}`);
      if (labels.has(record.label)) throw new Error(`credential label must be unique: ${record.label}`);
      labels.add(record.label);
      this.records.set(credential, record);
    }
  }

  resolve(credential, claimedRole) {
    return this.authorize(this.authenticate(credential), claimedRole);
  }

  authenticate(credential) {
    const record = typeof credential === 'string' ? this.records.get(credential) : undefined;
    if (!record) {
      throw new CredentialAuthorizationError('unknown_credential', 'credential is not recognized');
    }
    if (!record.enabled) {
      throw new CredentialAuthorizationError('disabled_credential', 'credential is disabled');
    }
    return record;
  }

  authorize(record, claimedRole) {
    if (!record || typeof record !== 'object') {
      throw new CredentialAuthorizationError('unknown_credential', 'credential is not recognized');
    }
    if (typeof claimedRole !== 'string' || claimedRole.length === 0 || claimedRole === '*') {
      throw new CredentialAuthorizationError('invalid_role', 'claimed role is invalid');
    }
    if (!record.allowedRoles.includes(claimedRole)) {
      throw new CredentialAuthorizationError('role_not_allowed', 'credential is not allowed for the claimed role');
    }
    return Object.freeze({
      project: record.project,
      label: record.label,
      role: claimedRole,
      trustedForDecisions: record.trustedForDecisions
    });
  }
}
