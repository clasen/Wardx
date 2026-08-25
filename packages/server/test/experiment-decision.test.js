import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideExperiment, normsInv } from '../src/control/experimentDecision.js';

const POLICY = {
  id: 'delay',
  enabled: true,
  goalMetric: 'message.sent',
  assignmentUnitKind: 'session',
  outcomeKind: 'conversion',
  control: 'control',
  targetSampleSizePerVariant: 50,
  earliestAnalysisAt: 1_000,
  familyWiseAlpha: 0.05,
  minimumEffect: 0,
  direction: 'increase',
  terminalRetentionMs: 60_000,
  healthThresholds: {
    maxDroppedFrames: 0,
    maxDuplicateExposures: 0,
    maxDuplicateGoals: 0,
    maxConflictingGoals: 0,
    maxVariantConflicts: 0,
    maxUntrustedRows: 0,
    maxLateRows: 0,
    maxMissingExposures: 0,
    maxImplicitExposures: 0
  },
  variants: [
    { key: 'control', weight: 50, values: {} },
    { key: 'fast', weight: 50, values: {} }
  ]
};

const CONTEXT = {
  analysisAt: 1_000,
  health: {
    droppedFrames: 0,
    duplicateExposures: 0,
    duplicateGoals: 0,
    conflictingGoals: 0,
    variantConflicts: 0,
    untrustedRows: 0,
    lateRows: 0,
    missingExposures: 0,
    implicitExposures: 0
  }
};

function row(key, exposures, goals, goalSum, goalSumSq) {
  return { key, exposures, goals, goalSum, goalSumSq };
}

test('normsInv matches known standard-normal quantiles', () => {
  assert.ok(Math.abs(normsInv(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normsInv(0.995) - 2.575829) < 1e-5);
  assert.equal(normsInv(0.5), 0);
});

test('decideExperiment is invalid without a complete terminal policy', () => {
  const decision = decideExperiment({ id: 'delay', enabled: true, variants: POLICY.variants }, [
    row('control', 80, 40, 40, 40),
    row('fast', 80, 70, 70, 70)
  ], CONTEXT);
  assert.equal(decision.status, 'invalid');
  assert.match(decision.reason, /descriptive/);
});

test('decideExperiment is collecting until minExposures', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 10, 4, 4, 4),
    row('fast', 12, 8, 8, 8)
  ], CONTEXT);
  assert.equal(decision.status, 'collecting');
  assert.equal(decision.next, 'wait');
  assert.equal(decision.sampleProgress, 10 / 50);
  assert.equal(decision.leadingVariant, 'fast');
});

test('decideExperiment declares a conversion winner', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 50, 10, 10, 10),
    row('fast', 50, 40, 40, 40)
  ], CONTEXT);
  assert.equal(decision.status, 'winner');
  assert.equal(decision.next, 'ship');
  assert.equal(decision.leadingVariant, 'fast');
  assert.equal(decision.sampleProgress, 1);
  const vs = decision.comparisons.find((row) => row.variant === 'fast');
  assert.equal(vs.beatsControl, true);
  assert.ok(vs.lower > 0);
});

test('decideExperiment is no_difference when rates match', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 50, 25, 25, 25),
    row('fast', 50, 25, 25, 25)
  ], CONTEXT);
  assert.equal(decision.status, 'inconclusive');
});

test('decideExperiment does not reverse a declared increase hypothesis', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 50, 40, 40, 40),
    row('fast', 50, 10, 10, 10)
  ], CONTEXT);
  assert.equal(decision.status, 'inconclusive');
});

test('decideExperiment reports shipped without re-testing', () => {
  const decision = decideExperiment({ ...POLICY, enabled: false, shippedVariant: 'fast' }, [
    row('control', 5, 1, 1, 1),
    row('fast', 5, 2, 2, 2)
  ], CONTEXT);
  assert.equal(decision.status, 'shipped');
  assert.equal(decision.leadingVariant, 'fast');
  assert.equal(decision.next, 'leave');
});

test('decideExperiment compares means with goalSumSq', () => {
  const decision = decideExperiment(
    { ...POLICY, outcomeKind: 'mean', targetSampleSizePerVariant: 3 },
    [
      row('control', 3, 3, 300, 90 * 90 + 100 * 100 + 110 * 110),
      row('fast', 3, 3, 600, 190 * 190 + 200 * 200 + 210 * 210)
    ],
    CONTEXT
  );
  assert.equal(decision.status, 'winner');
  assert.equal(decision.leadingVariant, 'fast');
});
