import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignVariant } from '../src/config/ExperimentResolver.js';
import { assignmentHash, hashToUnitInterval } from '../src/config/hash.js';
import { WardxCore } from '../src/WardxCore.js';
import { testSettings } from './helpers.js';

const experiment = {
  id: 'message-delay-v1',
  enabled: true,
  allocation: 1,
  salt: '3ad8f9',
  primaryMetric: 'message.sent',
  variants: [
    { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
    { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
  ]
};

test('same subject experiment and salt always map to the same variant', () => {
  const a = assignVariant(experiment, 'user-1');
  const b = assignVariant(experiment, 'user-1');
  assert.equal(a.key, b.key);
});

test('changing salt redistributes the subject', () => {
  const original = assignVariant(experiment, 'user-stable');
  const changed = assignVariant({ ...experiment, salt: 'other' }, 'user-stable');
  const hashA = assignmentHash(experiment.id, 'user-stable', experiment.salt);
  const hashB = assignmentHash(experiment.id, 'user-stable', 'other');
  assert.notEqual(hashA, hashB);
  assert.ok(original);
  assert.ok(changed);
});

test('allocation excludes subjects above the cutoff', () => {
  const partial = { ...experiment, allocation: 0.2 };
  let inExp = 0;
  let out = 0;
  for (let i = 0; i < 5000; i++) {
    if (assignVariant(partial, `s-${i}`)) inExp += 1;
    else out += 1;
  }
  const ratio = inExp / (inExp + out);
  assert.ok(ratio > 0.15 && ratio < 0.25, `allocation ratio ${ratio}`);
});

test('config.get uses fallback, remote, then experiment variant', () => {
  const core = new WardxCore(testSettings());
  assert.equal(core.configGet('message.delayMs', 7), 7);
  core.applyConfig(13, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  assert.equal(core.configGet('message.delayMs', 7), 1000);
  const withSubject = core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  assert.ok(withSubject === 1000 || withSubject === 400);
});

test('exposure is recorded once per experiment and subject in a session', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  const fitted = core.snapshotFrame();
  const exposures = fitted.frame.events.filter((row) => row[1] === 'experiment.exposure');
  assert.equal(exposures.length, 1);
  assert.equal(typeof exposures[0][2].subject, 'string');
  assert.notEqual(exposures[0][2].subject, 'user-1');
});

test('experiment.goal attaches known assignments', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  core.experimentGoal('message.sent', { subjectId: 'user-1', value: 1 });
  const fitted = core.snapshotFrame();
  const goals = fitted.frame.events.filter((row) => row[1] === 'experiment.goal');
  assert.equal(goals.length, 1);
  assert.equal(goals[0][2].metric, 'message.sent');
  assert.equal(goals[0][2].experiments.length, 1);
});

test('experiment.goal accepts a quantitative session duration', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'level.3.enemyHp': 100 },
    experiments: [
      {
        id: 'difficulty-v1',
        enabled: true,
        allocation: 1,
        salt: '3ad8f9',
        primaryMetric: 'session.duration',
        variants: [
          { key: 'control', weight: 50, values: { 'level.3.enemyHp': 100 } },
          { key: 'easy', weight: 50, values: { 'level.3.enemyHp': 70 } }
        ]
      }
    ]
  });
  core.configGet('level.3.enemyHp', 100, { subjectId: 'user-1' });
  core.experimentGoal('session.duration', { subjectId: 'user-1', value: 842000 });
  const fitted = core.snapshotFrame();
  const goals = fitted.frame.events.filter((row) => row[1] === 'experiment.goal');
  assert.equal(goals.length, 1);
  assert.equal(goals[0][2].metric, 'session.duration');
  assert.equal(goals[0][2].value, 842000);
});

test('identify supplies the subject for config.get and experiment.goal', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  assert.equal(core.configGet('message.delayMs', 7), 1000);
  core.identify('user-1');
  const identified = core.configGet('message.delayMs', 7);
  const explicit = core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  assert.equal(identified, explicit);
  assert.ok(identified === 1000 || identified === 400);
  core.experimentGoal('message.sent', { value: 1 });
  const fitted = core.snapshotFrame();
  const exposures = fitted.frame.events.filter((row) => row[1] === 'experiment.exposure');
  const goals = fitted.frame.events.filter((row) => row[1] === 'experiment.goal');
  assert.equal(exposures.length, 1);
  assert.equal(goals.length, 1);
  assert.equal(goals[0][2].metric, 'message.sent');
});

test('per-call subjectId overrides identify; identify(null) clears', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  core.identify('user-1');
  const other = core.configGet('message.delayMs', 7, { subjectId: 'user-2' });
  const identified = core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  assert.equal(other, core.configGet('message.delayMs', 7, { subjectId: 'user-2' }));
  assert.equal(identified, core.configGet('message.delayMs', 7));
  core.identify(null);
  assert.equal(core.configGet('message.delayMs', 7), 1000);
  assert.throws(() => core.experimentGoal('message.sent'), /subjectId/);
});

test('identify rejects a non-string or empty subject', () => {
  const core = new WardxCore(testSettings());
  assert.throws(() => core.identify(''), /non-empty/);
  assert.throws(() => core.identify(12), /non-empty/);
});

test('unit interval is hash / 2^32', () => {
  const hash = assignmentHash(experiment.id, 'x', experiment.salt);
  assert.ok(hashToUnitInterval(hash) >= 0);
  assert.ok(hashToUnitInterval(hash) < 1);
});
