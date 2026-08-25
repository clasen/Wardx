import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../src/storage/SqliteStateStore.js';
import { ExperimentLedger } from '../src/storage/ExperimentLedger.js';

const SETTINGS = {
  synchronous: 'FULL',
  busyTimeoutMs: 1000,
  walAutoCheckpointPages: 100,
  checkpointMode: 'TRUNCATE',
  maxWriteBatch: 100,
  transactionTimeoutMs: 1000,
  maxHistoryBuckets: 100,
  maxHistoryRows: 1000
};
const HASH = 'ab'.repeat(32);
const SECOND_HASH = 'cd'.repeat(32);
const THIRD_HASH = 'ef'.repeat(32);
const SOURCE = { role: 'backend', trustedForDecisions: true };
const UNTRUSTED_SOURCE = { role: 'client', trustedForDecisions: false };

function withLedger(fn, maxRows = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-ledger-'));
  const store = new SqliteStateStore({ path: join(directory, 'state.sqlite'), settings: SETTINGS });
  const ledger = new ExperimentLedger({ store, maxRows });
  try {
    return fn(ledger, store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function exposure(assignmentHash, variant = 'a', timestamp = 1) {
  return { kind: 'exposure', experiment: 'exp', variant, assignmentHash, timestamp };
}

function goal(assignmentHash, value = 1, variant = 'a', timestamp = 2) {
  return { kind: 'goal', experiment: 'exp', variant, assignmentHash, timestamp, value };
}

function terminalDecision(status = 'winner') {
  return {
    status,
    method: 'fixed-horizon-newcombe-wilson-holm-v1',
    terminalInput: { analysisAt: 10, variants: { a: { exposures: 1, goals: 1, goalSum: 1, goalSumSq: 1 } } }
  };
}

test('ExperimentLedger deduplicates exposures and goals and preserves trusted provenance', () => {
  withLedger((ledger) => {
    const exposure = { kind: 'exposure', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 1 };
    const goal = { kind: 'goal', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 2, value: 1 };
    assert.equal(ledger.ingestBatch('demo', [exposure], SOURCE)[0].status, 'accepted_exposure');
    assert.equal(ledger.ingestBatch('demo', [exposure], SOURCE)[0].status, 'duplicate_exposure');
    assert.equal(ledger.ingestBatch('demo', [goal], SOURCE)[0].status, 'accepted_goal');
    assert.equal(ledger.ingestBatch('demo', [goal], SOURCE)[0].status, 'duplicate_goal');
    const totals = ledger.totals('demo', 'exp')[0];
    assert.equal(totals.exposures, 1);
    assert.equal(totals.goals, 1);
    assert.equal(totals.duplicateExposures, 1);
    assert.equal(totals.duplicateGoals, 1);
    assert.equal(totals.trustClass, 'trusted');
    assert.ok(totals.goals <= totals.exposures);
  });
});

test('ExperimentLedger rejects missing exposure, variant mismatch, and conflicting goals', () => {
  withLedger((ledger) => {
    const missing = { kind: 'goal', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 1, value: 1 };
    assert.equal(ledger.ingestBatch('demo', [missing], SOURCE)[0].status, 'missing_exposure');
    ledger.ingestBatch(
      'demo',
      [{ kind: 'exposure', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 2 }],
      SOURCE
    );
    assert.equal(
      ledger.ingestBatch(
        'demo',
        [{ kind: 'exposure', experiment: 'exp', variant: 'b', assignmentHash: HASH, timestamp: 3 }],
        SOURCE
      )[0].status,
      'variant_conflict'
    );
    ledger.ingestBatch(
      'demo',
      [{ kind: 'goal', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 4, value: 1 }],
      SOURCE
    );
    assert.equal(
      ledger.ingestBatch(
        'demo',
        [{ kind: 'goal', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 5, value: 2 }],
        SOURCE
      )[0].status,
      'conflicting_goal'
    );
    const totals = ledger.totals('demo', 'exp');
    const accepted = totals.find((row) => row.key === 'a');
    const conflict = totals.find((row) => row.key === 'b');
    assert.equal(accepted.missingExposures, 1);
    assert.equal(accepted.conflictingGoals, 1);
    assert.equal(conflict.variantConflicts, 1);
  });
});

test('ExperimentLedger persists terminal decisions once and expires ledger rows explicitly', () => {
  withLedger((ledger) => {
    ledger.ingestBatch(
      'demo',
      [{ kind: 'exposure', experiment: 'exp', variant: 'a', assignmentHash: HASH, timestamp: 1 }],
      SOURCE
    );
    const winner = terminalDecision();
    assert.deepEqual(ledger.persistTerminalDecision('demo', 'exp', winner, 10), winner);
    assert.deepEqual(ledger.persistTerminalDecision('demo', 'exp', terminalDecision('no_difference'), 11), winner);
    assert.equal(ledger.scheduleExpiry('demo', 'exp', 20), 1);
    assert.equal(ledger.scheduleExpiry('demo', 'exp', 30), 0);
    assert.equal(ledger.pruneExpired(19), 0);
    assert.equal(ledger.pruneExpired(20), 1);
    assert.deepEqual(ledger.readTerminalDecision('demo', 'exp'), winner);
    assert.equal(ledger.ingestBatch('demo', [exposure(SECOND_HASH, 'a', 21)], SOURCE)[0].status, 'late_row');
    assert.equal(ledger.totals('demo', 'exp').find((row) => row.trustClass === 'trusted').lateRows, 1);
  });
});

test('ExperimentLedger preflights an entire batch before any evidence mutation', () => {
  withLedger((ledger) => {
    assert.throws(
      () => ledger.ingestBatch('demo', [exposure(HASH), exposure('deadbeef')], SOURCE),
      /64 lowercase hexadecimal/
    );
    assert.equal(ledger.ingestBatch('demo', [exposure(HASH)], SOURCE)[0].status, 'accepted_exposure');

    const rejected = ledger.ingestBatch('demo', [exposure(SECOND_HASH), exposure(HASH, 'b')], SOURCE);
    assert.equal(rejected[0].status, 'variant_conflict');
    assert.equal(ledger.ingestBatch('demo', [exposure(SECOND_HASH)], SOURCE)[0].status, 'accepted_exposure');
    const totals = ledger.totals('demo', 'exp').find((row) => row.key === 'b');
    assert.equal(totals.variantConflicts, 1);
  });
});

test('ExperimentLedger capacity preflight rejects the whole batch', () => {
  withLedger((ledger) => {
    assert.throws(
      () => ledger.ingestBatch('demo', [exposure(HASH), exposure(SECOND_HASH)], SOURCE),
      /capacity exceeded/
    );
    assert.equal(ledger.ingestBatch('demo', [exposure(HASH)], SOURCE)[0].status, 'accepted_exposure');
  }, 1);
});

test('ExperimentLedger keeps trusted and untrusted evidence and health separate', () => {
  withLedger((ledger) => {
    ledger.ingestBatch('demo', [exposure(HASH), goal(HASH)], SOURCE);
    ledger.ingestBatch('demo', [exposure(SECOND_HASH), goal(SECOND_HASH)], UNTRUSTED_SOURCE);
    ledger.ingestBatch('demo', [exposure(THIRD_HASH)], UNTRUSTED_SOURCE);
    assert.equal(ledger.ingestBatch('demo', [goal(THIRD_HASH)], SOURCE)[0].status, 'missing_exposure');

    const totals = ledger.totals('demo', 'exp');
    const trusted = totals.find((row) => row.trustClass === 'trusted');
    const untrusted = totals.find((row) => row.trustClass === 'untrusted');
    assert.deepEqual(
      { exposures: trusted.exposures, goals: trusted.goals, missingExposures: trusted.missingExposures, untrustedRows: trusted.untrustedRows },
      { exposures: 1, goals: 1, missingExposures: 1, untrustedRows: 0 }
    );
    assert.deepEqual(
      { exposures: untrusted.exposures, goals: untrusted.goals, untrustedRows: untrusted.untrustedRows },
      { exposures: 2, goals: 1, untrustedRows: 3 }
    );
  });
});

test('ExperimentLedger stores distinct 256-bit identifiers and rejects shorter IDs', () => {
  withLedger((ledger) => {
    ledger.ingestBatch('demo', [exposure(HASH), exposure(SECOND_HASH)], SOURCE);
    assert.equal(ledger.totals('demo', 'exp')[0].exposures, 2);
    assert.throws(() => ledger.ingestBatch('demo', [exposure('01234567')], SOURCE), /64 lowercase hexadecimal/);
    assert.equal(ledger.totals('demo', 'exp')[0].exposures, 2);
  });
});

test('ExperimentLedger validates terminal persistence before the first write', () => {
  withLedger((ledger) => {
    assert.throws(
      () => ledger.persistTerminalDecision('demo', 'exp', { status: 'collecting' }, 10),
      /terminal decision status/
    );
    assert.equal(ledger.readTerminalDecision('demo', 'exp'), null);
    assert.throws(
      () => ledger.persistTerminalDecision('demo', 'exp', { status: 'winner' }, 10),
      /method/
    );
    assert.equal(ledger.readTerminalDecision('demo', 'exp'), null);
  });
});
