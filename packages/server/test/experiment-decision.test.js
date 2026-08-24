import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideExperiment, normsInv } from '../src/control/experimentDecision.js';

const POLICY = {
  id: 'delay',
  enabled: true,
  goalMetric: 'message.sent',
  goalKind: 'conversion',
  control: 'control',
  minExposures: 50,
  confidence: 0.95,
  variants: [
    { key: 'control', weight: 50, values: {} },
    { key: 'fast', weight: 50, values: {} }
  ]
};

function row(key, exposures, goals, goalSum, goalSumSq) {
  return { key, exposures, goals, goalSum, goalSumSq };
}

test('normsInv matches known standard-normal quantiles', () => {
  assert.ok(Math.abs(normsInv(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normsInv(0.995) - 2.575829) < 1e-5);
  assert.equal(normsInv(0.5), 0);
});

test('decideExperiment is cannot_decide without policy fields', () => {
  const decision = decideExperiment({ id: 'delay', enabled: true, variants: POLICY.variants }, [
    row('control', 80, 40, 40, 40),
    row('fast', 80, 70, 70, 70)
  ]);
  assert.equal(decision.status, 'cannot_decide');
  assert.equal(decision.next, 'configure');
  assert.match(decision.reason, /goalKind/);
});

test('decideExperiment is collecting until minExposures', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 10, 4, 4, 4),
    row('fast', 12, 8, 8, 8)
  ]);
  assert.equal(decision.status, 'collecting');
  assert.equal(decision.next, 'wait');
  assert.equal(decision.sampleProgress, 10 / 50);
  assert.equal(decision.leadingVariant, 'fast');
});

test('decideExperiment declares a conversion winner', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 50, 10, 10, 10),
    row('fast', 50, 40, 40, 40)
  ]);
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
  ]);
  assert.equal(decision.status, 'no_difference');
  assert.equal(decision.next, 'leave');
});

test('decideExperiment ships control when every other variant loses', () => {
  const decision = decideExperiment(POLICY, [
    row('control', 50, 40, 40, 40),
    row('fast', 50, 10, 10, 10)
  ]);
  assert.equal(decision.status, 'winner');
  assert.equal(decision.leadingVariant, 'control');
});

test('decideExperiment reports shipped without re-testing', () => {
  const decision = decideExperiment({ ...POLICY, enabled: false, shippedVariant: 'fast' }, [
    row('control', 5, 1, 1, 1),
    row('fast', 5, 2, 2, 2)
  ]);
  assert.equal(decision.status, 'shipped');
  assert.equal(decision.leadingVariant, 'fast');
  assert.equal(decision.next, 'leave');
});

test('decideExperiment compares means with goalSumSq', () => {
  const decision = decideExperiment(
    { ...POLICY, goalKind: 'mean', minExposures: 3 },
    [
      row('control', 3, 3, 300, 90 * 90 + 100 * 100 + 110 * 110),
      row('fast', 3, 3, 600, 190 * 190 + 200 * 200 + 210 * 210)
    ]
  );
  assert.equal(decision.status, 'winner');
  assert.equal(decision.leadingVariant, 'fast');
});
