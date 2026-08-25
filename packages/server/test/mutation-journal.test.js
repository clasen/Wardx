import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutationConflictError, MutationJournal } from '../src/control/MutationJournal.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeRepository {
  constructor(initial) {
    this.snapshot = clone(initial);
    this.failNextCommit = false;
  }

  read() {
    return clone(this.snapshot);
  }

  transact(_project, callback) {
    const outcome = callback(clone(this.snapshot));
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('durable commit failed');
    }
    this.snapshot = clone(outcome.next);
    return clone(outcome.result);
  }
}

function applyPatch(state, patch) {
  for (const [key, value] of Object.entries(patch.set || {})) state[key] = value;
  for (const key of patch.delete || []) delete state[key];
  return state;
}

function fixture(capacity = 10) {
  const repository = new FakeRepository({ version: 7, state: { timeoutMs: 5000 }, changes: [] });
  let id = 0;
  const journal = new MutationJournal({
    repository,
    capacity,
    applyChange: applyPatch,
    clock: () => 1_800_000_000_000 + id,
    idFactory: () => `change-${++id}`
  });
  return { journal, repository };
}

function setTimeoutMutation(expectedVersion, value, before = 5000) {
  return {
    project: 'demo',
    expectedVersion,
    reason: 'Tune matchmaking after the declared test',
    clientIdentity: { name: 'codex', version: '1.2.3', verified: false },
    operation: 'set_config_value',
    affectedNames: ['timeoutMs'],
    forward: { set: { timeoutMs: value } },
    inverse: { set: { timeoutMs: before } }
  };
}

test('MutationJournal atomically records a versioned reversible mutation and absent identity', () => {
  const { journal, repository } = fixture();
  const committed = journal.commit(setTimeoutMutation(7, 3500));
  assert.deepEqual(committed, { version: 8, changeId: 'change-1' });
  assert.equal(repository.snapshot.state.timeoutMs, 3500);
  const [entry] = repository.snapshot.changes;
  assert.equal(entry.previousVersion, 7);
  assert.equal(entry.newVersion, 8);
  assert.equal(entry.reason, 'Tune matchmaking after the declared test');
  assert.deepEqual(entry.clientIdentity, {
    available: true,
    verified: false,
    name: 'codex',
    version: '1.2.3'
  });
  assert.deepEqual(entry.reversible.inverse, { set: { timeoutMs: 5000 } });

  journal.commit({
    ...setTimeoutMutation(8, 3000, 3500),
    clientIdentity: undefined
  });
  assert.deepEqual(repository.snapshot.changes[1].clientIdentity, { available: false, verified: false });
});

test('MutationJournal version conflict changes neither state nor journal and reports currentVersion', () => {
  const { journal, repository } = fixture();
  journal.commit(setTimeoutMutation(7, 3500));
  const before = repository.read('demo');
  assert.throws(
    () => journal.commit(setTimeoutMutation(7, 1000)),
    (error) =>
      error instanceof MutationConflictError &&
      error.code === 'version_conflict' &&
      error.currentVersion === 8
  );
  assert.deepEqual(repository.read('demo'), before);
});

test('MutationJournal normalizes a repository CAS race to a conflict with the durable version', () => {
  const { journal, repository } = fixture();
  repository.transact = (_project, callback) => {
    callback(clone(repository.snapshot));
    repository.snapshot = {
      version: 8,
      state: { timeoutMs: 5000, otherWriter: true },
      changes: []
    };
    throw new Error('project version conflict: current version is 8');
  };
  assert.throws(
    () => journal.commit(setTimeoutMutation(7, 3500)),
    (error) => error instanceof MutationConflictError && error.currentVersion === 8
  );
  assert.deepEqual(repository.snapshot.state, { timeoutMs: 5000, otherWriter: true });
  assert.deepEqual(repository.snapshot.changes, []);
});

test('MutationJournal rollback creates a new version and preserves intervening unrelated values', () => {
  const { journal, repository } = fixture();
  const original = journal.commit(setTimeoutMutation(7, 3500));
  journal.commit({
    project: 'demo',
    expectedVersion: 8,
    reason: 'Enable the separately reviewed flag',
    operation: 'set_config_value',
    affectedNames: ['chatEnabled'],
    forward: { set: { chatEnabled: true } },
    inverse: { delete: ['chatEnabled'] }
  });
  const rolledBack = journal.rollback({
    project: 'demo',
    changeId: original.changeId,
    expectedVersion: 9,
    reason: 'Observed regression after deployment'
  });

  assert.deepEqual(rolledBack, {
    version: 10,
    changeId: 'change-3',
    rolledBackChangeId: 'change-1'
  });
  assert.deepEqual(repository.snapshot.state, { timeoutMs: 5000, chatEnabled: true });
  const rollback = repository.snapshot.changes.at(-1);
  assert.equal(rollback.operation, 'rollback_config_change');
  assert.equal(rollback.previousVersion, 9);
  assert.equal(rollback.newVersion, 10);
  assert.equal(rollback.rolledBackChangeId, 'change-1');

  const beforeConflict = repository.read('demo');
  assert.throws(
    () => journal.rollback({
      project: 'demo',
      changeId: original.changeId,
      expectedVersion: 9,
      reason: 'stale rollback'
    }),
    (error) => error instanceof MutationConflictError && error.currentVersion === 10
  );
  assert.deepEqual(repository.read('demo'), beforeConflict);
});

test('MutationJournal enforces bounded retention and reports the oldest reversible version', () => {
  const { journal } = fixture(2);
  journal.commit(setTimeoutMutation(7, 4000));
  journal.commit(setTimeoutMutation(8, 3000, 4000));
  journal.commit(setTimeoutMutation(9, 2000, 3000));
  const listed = journal.list('demo');
  assert.equal(listed.currentVersion, 10);
  assert.equal(listed.oldestAvailableVersion, 8);
  assert.deepEqual(listed.changes.map((entry) => entry.id), ['change-2', 'change-3']);
  assert.equal(listed.changes.some((entry) => Object.hasOwn(entry, 'reversible')), false);
  assert.doesNotMatch(JSON.stringify(listed), /"timeoutMs":3000|"timeoutMs":2000/);
});

test('MutationJournal publishes nothing when the durable transaction fails', () => {
  const { journal, repository } = fixture();
  const before = repository.read('demo');
  repository.failNextCommit = true;
  assert.throws(() => journal.commit(setTimeoutMutation(7, 3500)), /durable commit failed/);
  assert.deepEqual(repository.read('demo'), before);
});

test('MutationJournal rejects empty reasons and prohibited audit fields before mutation', () => {
  const { journal, repository } = fixture();
  const before = repository.read('demo');
  assert.throws(() => journal.commit({ ...setTimeoutMutation(7, 3500), reason: '  ' }), /reason/);
  assert.throws(
    () => journal.commit({
      ...setTimeoutMutation(7, 3500),
      forward: { set: { timeoutMs: 3500 }, subjectId: 'raw-subject' }
    }),
    /prohibited audit field: subjectId/
  );
  assert.deepEqual(repository.read('demo'), before);
});
