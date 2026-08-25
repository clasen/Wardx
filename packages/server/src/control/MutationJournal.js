import { randomUUID } from 'node:crypto';

const UNSAFE_AUDIT_FIELDS = new Set([
  'credential',
  'password',
  'projectkey',
  'rawkey',
  'secret',
  'subject',
  'subjectid',
  'token'
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function cloneJson(value, label) {
  if (value === undefined) throw new Error(`${label} must be JSON-serializable`);
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (json === undefined) throw new Error(`${label} must be JSON-serializable`);
  return JSON.parse(json);
}

function assertAuditSafe(value, label, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertAuditSafe(value[i], `${label}[${i}]`, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_AUDIT_FIELDS.has(key.toLowerCase())) {
        throw new Error(`${label} contains prohibited audit field: ${key}`);
      }
      assertAuditSafe(child, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function normalizeAffectedNames(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('affectedNames must be a non-empty array');
  }
  const seen = new Set();
  for (const name of value) {
    assertNonEmptyString(name, 'affectedNames item');
    if (seen.has(name)) throw new Error(`affectedNames duplicate: ${name}`);
    seen.add(name);
  }
  return [...seen];
}

function normalizeClientIdentity(value) {
  if (value === undefined || value === null) {
    return { available: false, verified: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('clientIdentity must be an object when provided');
  }
  assertNonEmptyString(value.name, 'clientIdentity.name');
  if (value.version !== undefined) assertNonEmptyString(value.version, 'clientIdentity.version');
  if (value.verified !== undefined && typeof value.verified !== 'boolean') {
    throw new Error('clientIdentity.verified must be a boolean');
  }
  const identity = {
    available: true,
    verified: value.verified === true,
    name: value.name
  };
  if (value.version !== undefined) identity.version = value.version;
  return identity;
}

function validateVersion(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be an integer >= 0`);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('mutation repository snapshot must be an object');
  }
  validateVersion(snapshot.version, 'mutation repository snapshot.version');
  if (!Array.isArray(snapshot.changes)) throw new Error('mutation repository snapshot.changes must be an array');
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'state')) {
    throw new Error('mutation repository snapshot.state is required');
  }
}

function retainedChanges(changes, entry, capacity) {
  const next = [...changes, entry];
  if (next.length > capacity) next.splice(0, next.length - capacity);
  return next;
}

function entryIdentity(idFactory, changes) {
  const id = idFactory();
  assertNonEmptyString(id, 'change id');
  if (changes.some((entry) => entry.id === id)) throw new Error(`duplicate change id: ${id}`);
  return id;
}

function entryTimestamp(clock) {
  const timestamp = clock();
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw new Error('change timestamp must be an integer >= 0');
  }
  return timestamp;
}

function validateRetainedChange(entry, project) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('retained config change is invalid');
  }
  assertNonEmptyString(entry.id, 'retained config change id');
  if (entry.project !== project) throw new Error('retained config change project mismatch');
  validateVersion(entry.previousVersion, 'retained config change previousVersion');
  validateVersion(entry.newVersion, 'retained config change newVersion');
  if (entry.newVersion !== entry.previousVersion + 1) {
    throw new Error('retained config change versions must be consecutive');
  }
  normalizeAffectedNames(entry.affectedNames);
  if (!entry.reversible || typeof entry.reversible !== 'object' || Array.isArray(entry.reversible)) {
    throw new Error('retained config change reversible data is required');
  }
  assertAuditSafe(entry.reversible.forward, 'retained forward');
  assertAuditSafe(entry.reversible.inverse, 'retained inverse');
}

function publicEntry(entry) {
  const out = {
    id: entry.id,
    timestamp: entry.timestamp,
    project: entry.project,
    previousVersion: entry.previousVersion,
    newVersion: entry.newVersion,
    operation: entry.operation,
    affectedNames: cloneJson(entry.affectedNames, 'affectedNames'),
    reason: entry.reason,
    clientIdentity: cloneJson(entry.clientIdentity, 'clientIdentity')
  };
  if (entry.rolledBackChangeId !== undefined) out.rolledBackChangeId = entry.rolledBackChangeId;
  return out;
}

function prepareMutation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('mutation is required');
  assertNonEmptyString(input.project, 'project');
  validateVersion(input.expectedVersion, 'expectedVersion');
  assertNonEmptyString(input.reason, 'reason');
  assertNonEmptyString(input.operation, 'operation');
  const affectedNames = normalizeAffectedNames(input.affectedNames);
  assertAuditSafe(input.forward, 'forward');
  assertAuditSafe(input.inverse, 'inverse');
  return {
    project: input.project,
    expectedVersion: input.expectedVersion,
    reason: input.reason.trim(),
    operation: input.operation,
    affectedNames,
    clientIdentity: normalizeClientIdentity(input.clientIdentity),
    forward: cloneJson(input.forward, 'forward'),
    inverse: cloneJson(input.inverse, 'inverse')
  };
}

export class MutationConflictError extends Error {
  constructor(currentVersion) {
    super(`version conflict: current version is ${currentVersion}`);
    this.name = 'MutationConflictError';
    this.code = 'version_conflict';
    this.currentVersion = currentVersion;
  }
}

export class MutationJournal {
  constructor({ repository, capacity, applyChange, clock = Date.now, idFactory = randomUUID }) {
    if (!repository || typeof repository.read !== 'function' || typeof repository.transact !== 'function') {
      throw new Error('mutation repository with read and transact is required');
    }
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('journal capacity must be an integer >= 1');
    if (typeof applyChange !== 'function') throw new Error('applyChange is required');
    if (typeof clock !== 'function') throw new Error('clock must be a function');
    if (typeof idFactory !== 'function') throw new Error('idFactory must be a function');
    this.repository = repository;
    this.capacity = capacity;
    this.applyChange = applyChange;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  _transact(project, expectedVersion, work) {
    try {
      return this.repository.transact(project, work);
    } catch (error) {
      if (error instanceof MutationConflictError) throw error;
      let current;
      try {
        current = this.repository.read(project);
        validateSnapshot(current);
      } catch {
        throw error;
      }
      if (current.version !== expectedVersion) throw new MutationConflictError(current.version);
      throw error;
    }
  }

  commit(input) {
    const mutation = prepareMutation(input);
    return this._transact(mutation.project, mutation.expectedVersion, (current) => {
      validateSnapshot(current);
      if (current.version !== mutation.expectedVersion) {
        throw new MutationConflictError(current.version);
      }
      const nextVersion = current.version + 1;
      const nextState = this.applyChange(cloneJson(current.state, 'state'), cloneJson(mutation.forward, 'forward'));
      const entry = {
        id: entryIdentity(this.idFactory, current.changes),
        timestamp: entryTimestamp(this.clock),
        project: mutation.project,
        previousVersion: current.version,
        newVersion: nextVersion,
        operation: mutation.operation,
        affectedNames: mutation.affectedNames,
        reason: mutation.reason,
        clientIdentity: mutation.clientIdentity,
        reversible: {
          forward: mutation.forward,
          inverse: mutation.inverse
        }
      };
      return {
        next: {
          version: nextVersion,
          state: cloneJson(nextState, 'next state'),
          changes: retainedChanges(current.changes, entry, this.capacity)
        },
        result: { version: nextVersion, changeId: entry.id }
      };
    });
  }

  rollback({ project, changeId, expectedVersion, reason, clientIdentity }) {
    assertNonEmptyString(project, 'project');
    assertNonEmptyString(changeId, 'changeId');
    validateVersion(expectedVersion, 'expectedVersion');
    assertNonEmptyString(reason, 'reason');
    const identity = normalizeClientIdentity(clientIdentity);
    return this._transact(project, expectedVersion, (current) => {
      validateSnapshot(current);
      if (current.version !== expectedVersion) throw new MutationConflictError(current.version);
      const target = current.changes.find((entry) => entry.id === changeId);
      if (!target) throw new Error(`retained config change not found: ${changeId}`);
      validateRetainedChange(target, project);
      const nextVersion = current.version + 1;
      const forward = cloneJson(target.reversible.inverse, 'retained inverse');
      const inverse = cloneJson(target.reversible.forward, 'retained forward');
      const nextState = this.applyChange(cloneJson(current.state, 'state'), cloneJson(forward, 'rollback change'));
      const entry = {
        id: entryIdentity(this.idFactory, current.changes),
        timestamp: entryTimestamp(this.clock),
        project,
        previousVersion: current.version,
        newVersion: nextVersion,
        operation: 'rollback_config_change',
        affectedNames: [...target.affectedNames],
        reason: reason.trim(),
        clientIdentity: identity,
        rolledBackChangeId: target.id,
        reversible: { forward, inverse }
      };
      return {
        next: {
          version: nextVersion,
          state: cloneJson(nextState, 'next state'),
          changes: retainedChanges(current.changes, entry, this.capacity)
        },
        result: { version: nextVersion, changeId: entry.id, rolledBackChangeId: target.id }
      };
    });
  }

  list(project) {
    assertNonEmptyString(project, 'project');
    const snapshot = this.repository.read(project);
    validateSnapshot(snapshot);
    const changes = cloneJson(snapshot.changes, 'changes');
    for (const entry of changes) validateRetainedChange(entry, project);
    return {
      currentVersion: snapshot.version,
      oldestAvailableVersion: changes.length > 0 ? changes[0].previousVersion : snapshot.version,
      changes: changes.map(publicEntry)
    };
  }
}
