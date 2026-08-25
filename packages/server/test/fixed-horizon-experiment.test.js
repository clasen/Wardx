import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideExperiment, holmAdjust } from '../src/control/experimentDecision.js';
import { validateExperiment } from '../src/control/validateExperiment.js';

const HEALTH_THRESHOLDS = {
  maxDroppedFrames: 0,
  maxDuplicateExposures: 0,
  maxDuplicateGoals: 0,
  maxConflictingGoals: 0,
  maxVariantConflicts: 0,
  maxUntrustedRows: 0,
  maxLateRows: 0,
  maxMissingExposures: 0,
  maxImplicitExposures: 0
};

const HEALTHY = {
  droppedFrames: 0,
  duplicateExposures: 0,
  duplicateGoals: 0,
  conflictingGoals: 0,
  variantConflicts: 0,
  untrustedRows: 0,
  lateRows: 0,
  missingExposures: 0,
  implicitExposures: 0
};

const PLAN = {
  id: 'delay-v2',
  enabled: true,
  allocation: 1,
  salt: 'delay-v2-salt',
  roles: ['client'],
  goalMetric: 'message.sent',
  assignmentUnitKind: 'session',
  outcomeKind: 'conversion',
  control: 'control',
  targetSampleSizePerVariant: 100,
  earliestAnalysisAt: 2_000,
  familyWiseAlpha: 0.05,
  minimumEffect: 0.02,
  direction: 'increase',
  terminalRetentionMs: 86_400_000,
  healthThresholds: HEALTH_THRESHOLDS,
  variants: [
    { key: 'control', weight: 50, values: {} },
    { key: 'fast', weight: 50, values: {} }
  ]
};

function conversionRow(key, exposures, goals) {
  return { key, exposures, goals, goalSum: goals, goalSumSq: goals };
}

function meanRow(key, values) {
  const sum = values.reduce((total, value) => total + value, 0);
  const sumSq = values.reduce((total, value) => total + value * value, 0);
  return { key, exposures: values.length, goals: values.length, goalSum: sum, goalSumSq: sumSq };
}

test('fixed-horizon plans require every policy and health threshold', () => {
  assert.doesNotThrow(() => validateExperiment(PLAN));
  for (const field of [
    'outcomeKind',
    'control',
    'targetSampleSizePerVariant',
    'earliestAnalysisAt',
    'familyWiseAlpha',
    'minimumEffect',
    'direction',
    'healthThresholds'
  ]) {
    const candidate = { ...PLAN };
    delete candidate[field];
    assert.throws(() => validateExperiment(candidate), new RegExp(`${field} is required`));
  }
  const incompleteHealth = { ...HEALTH_THRESHOLDS };
  delete incompleteHealth.maxLateRows;
  assert.throws(
    () => validateExperiment({ ...PLAN, healthThresholds: incompleteHealth }),
    /healthThresholds.maxLateRows is required/
  );
});

test('descriptive experiments remain valid only when they declare no terminal-plan field', () => {
  const descriptive = { ...PLAN };
  for (const field of [
    'outcomeKind',
    'control',
    'targetSampleSizePerVariant',
    'earliestAnalysisAt',
    'familyWiseAlpha',
    'minimumEffect',
    'direction',
    'healthThresholds'
  ]) delete descriptive[field];
  assert.doesNotThrow(() => validateExperiment(descriptive));
  assert.throws(() => validateExperiment({ ...descriptive, assignmentUnitKind: undefined }), /assignmentUnitKind is required/);
  assert.throws(() => validateExperiment({ ...descriptive, terminalRetentionMs: undefined }), /terminalRetentionMs is required/);
  assert.throws(() => validateExperiment({ ...descriptive, outcomeKind: 'conversion' }), /control is required/);
  assert.throws(() => validateExperiment({ ...descriptive, minExposures: 10 }), /unknown key: minExposures/);
});

test('analysis remains collecting until both sample and time horizons are met', () => {
  const rows = [conversionRow('control', 100, 20), conversionRow('fast', 100, 60)];
  const beforeTime = decideExperiment(PLAN, rows, { analysisAt: 1_999, health: HEALTHY });
  assert.equal(beforeTime.status, 'collecting');
  assert.deepEqual(beforeTime.horizon, { timeReached: false, sampleReached: true });

  const beforeSample = decideExperiment(
    PLAN,
    [conversionRow('control', 99, 20), conversionRow('fast', 100, 60)],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(beforeSample.status, 'collecting');
  assert.deepEqual(beforeSample.horizon, { timeReached: true, sampleReached: false });
});

test('Newcombe conversion analysis returns a material fixed-horizon winner', () => {
  const decision = decideExperiment(
    PLAN,
    [conversionRow('control', 100, 20), conversionRow('fast', 100, 50)],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(decision.status, 'winner');
  assert.equal(decision.leadingVariant, 'fast');
  assert.equal(decision.method, 'fixed-horizon-newcombe-wilson-holm-v1');
  assert.equal(decision.comparisons.length, 1);
  assert.ok(Math.abs(decision.comparisons[0].effect - 0.3) < 1e-12);
  assert.ok(decision.comparisons[0].lower > PLAN.minimumEffect);
  assert.equal(decision.comparisons[0].significant, true);
  assert.equal(decision.terminalInput.variants.fast.exposures, 100);
});

test('fixed horizon distinguishes no_difference from inconclusive', () => {
  const precisePlan = { ...PLAN, targetSampleSizePerVariant: 10_000 };
  const noDifference = decideExperiment(
    precisePlan,
    [conversionRow('control', 10_000, 5_000), conversionRow('fast', 10_000, 5_000)],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(noDifference.status, 'no_difference');

  const inconclusive = decideExperiment(
    PLAN,
    [conversionRow('control', 100, 50), conversionRow('fast', 100, 55)],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(inconclusive.status, 'inconclusive');
});

test('Welch mean analysis honors a declared decrease direction', () => {
  const meanPlan = {
    ...PLAN,
    outcomeKind: 'mean',
    direction: 'decrease',
    minimumEffect: 1,
    targetSampleSizePerVariant: 6
  };
  const decision = decideExperiment(
    meanPlan,
    [meanRow('control', [98, 99, 100, 100, 101, 102]), meanRow('fast', [78, 79, 80, 80, 81, 82])],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(decision.status, 'winner');
  assert.equal(decision.leadingVariant, 'fast');
  assert.equal(decision.method, 'fixed-horizon-welch-holm-v1');
  assert.ok(decision.comparisons[0].upper < -1);
  assert.ok(decision.comparisons[0].degreesOfFreedom > 0);
});

test('Holm correction stops after the first non-rejection', () => {
  const adjusted = holmAdjust([
    { key: 'a', pValue: 0.01 },
    { key: 'b', pValue: 0.03 },
    { key: 'c', pValue: 0.04 }
  ], 0.05);
  assert.deepEqual(
    adjusted.map((row) => [row.key, row.holmAlpha, row.significant, Number(row.adjustedPValue.toFixed(2))]),
    [
      ['a', 0.05 / 3, true, 0.03],
      ['b', 0.05 / 2, false, 0.06],
      ['c', 0.05, false, 0.06]
    ]
  );
});

test('multiple treatments use Holm and cannot promote a later comparison after a failed step', () => {
  const multi = {
    ...PLAN,
    targetSampleSizePerVariant: 200,
    variants: [
      ...PLAN.variants,
      { key: 'medium', weight: 50, values: {} }
    ]
  };
  const decision = decideExperiment(
    multi,
    [conversionRow('control', 200, 80), conversionRow('fast', 200, 120), conversionRow('medium', 200, 90)],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(decision.status, 'winner');
  assert.equal(decision.leadingVariant, 'fast');
  assert.equal(decision.comparisons.find((row) => row.variant === 'medium').significant, false);
});

test('terminal analysis rejects malformed or unhealthy evidence', () => {
  const duplicateGoals = decideExperiment(
    PLAN,
    [conversionRow('control', 100, 20), conversionRow('fast', 100, 50)],
    { analysisAt: 2_000, health: { ...HEALTHY, duplicateGoals: 1 } }
  );
  assert.equal(duplicateGoals.status, 'invalid');
  assert.match(duplicateGoals.reason, /duplicateGoals/);

  const impossibleRate = decideExperiment(
    PLAN,
    [conversionRow('control', 100, 20), conversionRow('fast', 100, 101)],
    { analysisAt: 2_000, health: HEALTHY }
  );
  assert.equal(impossibleRate.status, 'invalid');
  assert.match(impossibleRate.reason, /goals cannot exceed exposures/);
  assert.equal(impossibleRate.method, 'fixed-horizon-newcombe-wilson-holm-v1');
  assert.equal(impossibleRate.terminalInput.analysisAt, 2_000);
});

test('terminal output is deterministic and contains no wall-clock reads', () => {
  const rows = [conversionRow('control', 100, 20), conversionRow('fast', 100, 50)];
  const context = { analysisAt: 2_000, health: HEALTHY };
  assert.deepEqual(decideExperiment(PLAN, rows, context), decideExperiment(PLAN, rows, context));
  assert.equal(decideExperiment(PLAN, rows, { health: HEALTHY }).status, 'invalid');
});
