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
  goalMetric: 'message.sent',
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
  const exposures = fitted.frames.flatMap((frame) => frame.events).filter((row) => row[1] === 'experiment.exposure');
  assert.equal(exposures.length, 1);
  assert.equal(typeof exposures[0][2].subject, 'string');
  assert.notEqual(exposures[0][2].subject, 'user-1');
});

test('experiment.goal attaches only a previously exposed matching assignment', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  core.experimentGoal('message.sent', { subjectId: 'user-1', value: 1 });
  const fitted = core.snapshotFrame();
  const goals = fitted.frames.flatMap((frame) => frame.events).filter((row) => row[1] === 'experiment.goal');
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
        goalMetric: 'session.duration',
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
  const goals = fitted.frames.flatMap((frame) => frame.events).filter((row) => row[1] === 'experiment.goal');
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
  const rows = fitted.frames.flatMap((frame) => frame.events);
  const exposures = rows.filter((row) => row[1] === 'experiment.exposure');
  const goals = rows.filter((row) => row[1] === 'experiment.goal');
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

test('goalMetric is mandatory in every experiment snapshot', () => {
  const core = new WardxCore(testSettings());
  const { goalMetric: _removed, ...invalid } = experiment;
  assert.throws(
    () => core.applyConfig(1, { values: {}, experiments: [invalid] }),
    /goalMetric/
  );
});

test('simultaneous experiments emit only the goal row selected by goalMetric', () => {
  const second = {
    ...experiment,
    id: 'banner-v1',
    goalMetric: 'checkout.completed',
    variants: experiment.variants.map((variant) => ({
      ...variant,
      values: { 'banner.color': variant.key === 'control' ? 'blue' : 'green' }
    }))
  };
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000, 'banner.color': 'blue' },
    experiments: [experiment, second]
  });
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  core.configGet('banner.color', 'blue', { subjectId: 'user-1' });
  core.experimentGoal('checkout.completed', { subjectId: 'user-1', value: 3 });
  core.experimentGoal('not-configured', { subjectId: 'user-1' });
  const events = core.snapshotFrame().frames.flatMap((frame) => frame.events);
  const goals = events.filter((row) => row[1] === 'experiment.goal');
  assert.equal(goals.length, 1);
  assert.deepEqual(goals[0][2].experiments, [{ experiment: 'banner-v1', variant: goals[0][2].experiments[0].variant }]);
});

test('a goal before exposure produces no row', () => {
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  core.experimentGoal('message.sent', { subjectId: 'user-1' });
  const goals = core.snapshotFrame().frames.flatMap((frame) => frame.events)
    .filter((row) => row[1] === 'experiment.goal');
  assert.equal(goals.length, 0);
});

test('ambiguous exposed goal metrics fail instead of emitting multiple rows', () => {
  const second = {
    ...experiment,
    id: 'same-goal-v2',
    variants: experiment.variants.map((variant) => ({
      ...variant,
      values: { 'other.key': variant.key }
    }))
  };
  const core = new WardxCore(testSettings());
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000, 'other.key': 'control' },
    experiments: [experiment, second]
  });
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  core.configGet('other.key', 'control', { subjectId: 'user-1' });
  assert.throws(
    () => core.experimentGoal('message.sent', { subjectId: 'user-1' }),
    /multiple exposed experiments/
  );
});

test('experiment state is FIFO bounded, hashed, and permits exposure after eviction', () => {
  const core = new WardxCore(testSettings({ experimentStateMaxSubjects: 2, maxBufferedEvents: 20 }));
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  for (const subjectId of ['user-1', 'user-2', 'user-3']) {
    core.configGet('message.delayMs', 7, { subjectId });
  }
  assert.equal(core.experiments.stateBySubject.size, 2);
  assert.equal(core.experiments.stateBySubject.has(core.experiments.hashSubject('user-1')), false);
  for (const key of core.experiments.stateBySubject.keys()) {
    assert.equal(key.length, 64);
    assert.equal(key.startsWith('user-'), false);
  }
  core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  const exposures = core.snapshotFrame().frames.flatMap((frame) => frame.events)
    .filter((row) => row[1] === 'experiment.exposure');
  assert.equal(exposures.length, 4);
});

test('snapshot removal, disablement, and definition changes clear assignment state', () => {
  const core = new WardxCore(testSettings());
  const expose = (candidate, version) => {
    core.applyConfig(version, {
      values: { 'message.delayMs': 1000 },
      experiments: candidate ? [candidate] : []
    });
    if (candidate?.enabled) core.configGet('message.delayMs', 7, { subjectId: 'user-1' });
  };
  expose(experiment, 1);
  assert.equal(core.experiments.stateBySubject.size, 1);
  expose({ ...experiment, enabled: false }, 2);
  assert.equal(core.experiments.stateBySubject.size, 0);
  expose(experiment, 3);
  expose({ ...experiment, salt: 'changed' }, 4);
  assert.equal(core.experiments.stateBySubject.size, 1);
  assert.equal(core.experiments.assignmentsFor('user-1')[0].fingerprint.includes('changed'), false);
  expose(null, 5);
  assert.equal(core.experiments.stateBySubject.size, 0);
});

test('million subject assignments remain within configured capacity', { timeout: 60_000 }, () => {
  const core = new WardxCore(testSettings({
    experimentStateMaxSubjects: 128,
    maxBufferedEvents: 1
  }));
  core.applyConfig(1, {
    values: { 'message.delayMs': 1000 },
    experiments: [experiment]
  });
  for (let i = 0; i < 1_000_000; i++) {
    core.configGet('message.delayMs', 7, { subjectId: `subject-${i}` });
  }
  assert.equal(core.experiments.stateBySubject.size, 128);
});
