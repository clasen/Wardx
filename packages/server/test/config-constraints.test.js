import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { validateConfigConstraint, validateConfigConstraints } from '../src/control/configConstraints.js';
import { validateServerConfig } from '../src/loadConfig.js';
import { executeTool } from '../src/mcp/tools.js';
import { createIngestServer } from '../src/server.js';
import { testServerConfig } from './helpers.js';

const KEY = 'message.delayMs';
const CONSTRAINT = { type: 'integer', min: 0, max: 1000 };

function experiment(value, enabled = true) {
  return {
    id: 'delay', enabled, allocation: 1, salt: 'delay-test',
    primaryMetric: 'message.sent', goalMetric: 'message.sent',
    assignmentUnitKind: 'subject', terminalRetentionMs: 604800000,
    roles: ['client'],
    variants: [
      { key: 'control', weight: 50, values: { [KEY]: 1000 } },
      { key: 'test', weight: 50, values: { [KEY]: value } }
    ]
  };
}

function constrainedConfig() {
  const config = testServerConfig();
  config.projects.demo.catalog = { signals: { [KEY]: { description: 'Message delay', constraint: CONSTRAINT } } };
  return config;
}

function options(control) {
  return { expectedVersion: control.getConfig('demo').version, reason: 'verify constraint behavior' };
}

function rejectedAtomically(server, operation, pattern) {
  const control = server.wardx.control;
  const before = {
    config: control.getConfig('demo'),
    catalog: structuredClone(control.getCatalog('demo')),
    journal: control.listConfigChanges('demo'),
    stored: server.wardx.stateStore.readProjectState('demo')
  };
  assert.throws(operation, pattern);
  assert.deepEqual(control.getConfig('demo'), before.config);
  assert.deepEqual(control.getCatalog('demo'), before.catalog);
  assert.deepEqual(control.listConfigChanges('demo'), before.journal);
  assert.deepEqual(server.wardx.stateStore.readProjectState('demo'), before.stored);
}

test('constraints reject malformed contracts and contradictory allowed values', () => {
  const invalid = [
    null, [], {}, { type: 'float' }, { type: 'string', minimum: 1 },
    { type: 'string', min: 0 }, { type: 'number', min: NaN },
    { type: 'number', max: Infinity }, { type: 'number', min: 2, max: 1 },
    { type: 'integer', min: 0.1, max: 0.9 },
    { type: 'number', enum: [] }, { type: 'number', enum: [1, 1] },
    { type: 'number', enum: ['1'] }, { type: 'integer', enum: [1.1] },
    { type: 'number', min: 2, enum: [1] }, { type: 'number', enum: [Infinity] },
    { type: 'array', enum: [[]] }, { type: 'object', enum: [{}] }
  ];
  for (const constraint of invalid) {
    assert.throws(() => validateConfigConstraint(constraint, 'constraint'), { code: 'invalid_config_constraint' });
  }
});

test('constraints enforce JSON types, inclusive ranges and scalar enums without coercion', () => {
  const cases = [
    [{ type: 'number', min: 0, max: 1 }, [0, 0.5, 1], [-1, 2, '0.5', null, NaN, Infinity]],
    [{ type: 'integer', min: 0, max: 2 }, [0, 1, 2], [0.5, '1']],
    [{ type: 'string', enum: ['slow', 'fast'] }, ['slow', 'fast'], ['other', 1]],
    [{ type: 'boolean', enum: [false] }, [false], [true, 'false', 0]],
    [{ type: 'null', enum: [null] }, [null], [false, {}, []]],
    [{ type: 'object' }, [{}, Object.create(null)], [null, [], 'object', new Date(0), new Map(), Object(1)]],
    [{ type: 'array' }, [[]], [null, {}, 'array']]
  ];
  for (const [constraint, accepted, rejected] of cases) {
    validateConfigConstraint(constraint, 'constraint');
    const catalog = { signals: { setting: { constraint } } };
    for (const value of accepted) {
      assert.doesNotThrow(() => validateConfigConstraints({ values: { setting: value }, experiments: [] }, catalog));
    }
    for (const value of rejected) {
      assert.throws(() => validateConfigConstraints({ values: { setting: value }, experiments: [] }, catalog), {
        code: 'invalid_config_constraint'
      });
    }
  }
});

test('bootstrap validates constrained values and disabled experiment variants', () => {
  const config = constrainedConfig();
  config.projects.demo.values[KEY] = -1;
  assert.throws(() => validateServerConfig(config), /values.message.delayMs must be >= 0/);
  config.projects.demo.values[KEY] = 1000;
  config.projects.demo.experiments = [experiment(-1, false)];
  assert.throws(() => validateServerConfig(config), /variants.test.values.message.delayMs must be >= 0/);
});

test('MCP writes enforce constraints atomically and keep their metadata off the client wire', async () => {
  const server = createIngestServer(constrainedConfig());
  const control = server.wardx.control;
  try {
    for (const value of [-1, 1001, 1.5, '500', null]) {
      rejectedAtomically(server, () => executeTool(control, 'set_config_value', {
        project: 'demo', key: KEY, value, roles: ['client'], ...options(control)
      }), { code: 'invalid_config_constraint' });
    }
    executeTool(control, 'set_config_value', {
      project: 'demo', key: KEY, value: 500, roles: ['client'], ...options(control)
    });
    executeTool(control, 'set_signal', {
      project: 'demo', name: KEY, description: 'Delay in milliseconds', category: 'performance',
      constraint: { ...CONSTRAINT, enum: [0, 500, 1000] }, ...options(control)
    });
    rejectedAtomically(server, () => control.setValue('demo', KEY, 600, ['client'], options(control)), /allowed enum value/);
    const knob = executeTool(control, 'get_project_overview', { project: 'demo' }).knobs.find((entry) => entry.key === KEY);
    assert.deepEqual(knob.constraint, { ...CONSTRAINT, enum: [0, 500, 1000] });
    const wire = JSON.parse(server.wardx.registry.get('demo').configRepo.buildResponse(true, 'client'));
    assert.equal(wire.config.values[KEY], 500);
    assert.equal(JSON.stringify(wire).includes('constraint'), false);
    assert.equal(JSON.stringify(control.getConfig('demo')).includes('constraint'), false);

    executeTool(control, 'set_signal', {
      project: 'demo', name: KEY, description: 'Unrestricted delay', ...options(control)
    });
    control.setValue('demo', KEY, 'unrestricted', ['client'], options(control));
    assert.equal(control.getConfig('demo').values[KEY], 'unrestricted');
  } finally {
    await server.wardx.stop();
  }
});

test('object constraints reject non-JSON object instances before serialization', async () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  try {
    control.setSignal('demo', 'settings', {
      description: 'Object settings', constraint: { type: 'object' }
    }, options(control));
    control.setValue('demo', 'settings', { enabled: true }, ['client'], options(control));
    for (const value of [new Date(0), new Map(), Object(1), Object('value'), Object(false)]) {
      rejectedAtomically(server, () => control.setValue('demo', 'settings', value, ['client'], options(control)), /must have type object/);
    }
    control.setValue('demo', 'settings', Object.assign(Object.create(null), { enabled: false }), ['client'], options(control));
    assert.deepEqual(control.getConfig('demo').values.settings, { enabled: false });
  } finally {
    await server.wardx.stop();
  }
});

test('catalog tightening, variants and full snapshot replacement validate the complete candidate', async () => {
  const server = createIngestServer(constrainedConfig());
  const control = server.wardx.control;
  try {
    rejectedAtomically(server, () => control.setSignal('demo', KEY, {
      description: 'Delay', constraint: { type: 'integer', max: 900 }
    }, options(control)), /must be <= 900/);
    for (const enabled of [true, false]) {
      rejectedAtomically(server, () => control.upsertExperiment('demo', experiment(-1, enabled), options(control)), /must be >= 0/);
    }
    control.upsertExperiment('demo', experiment(100), options(control));
    rejectedAtomically(server, () => control.setSignal('demo', KEY, {
      description: 'Delay', constraint: { type: 'integer', min: 500 }
    }, options(control)), /variants.test.values.message.delayMs must be >= 500/);
    const replacement = control.getConfig('demo');
    replacement.values[KEY] = -1;
    rejectedAtomically(server, () => control.replaceSnapshot('demo', replacement, options(control)), /must be >= 0/);
  } finally {
    await server.wardx.stop();
  }
});

test('rollback cannot restore a value or constraint inconsistent with the resulting state', async () => {
  const server = createIngestServer(testServerConfig());
  const control = server.wardx.control;
  const reports = [];
  control.diagnostics = { report(...args) { reports.push(args); } };
  try {
    const changedValue = control.setValue('demo', KEY, 100, ['client'], options(control));
    const constrained = control.setSignal('demo', KEY, {
      description: 'Delay', constraint: { type: 'integer', max: 500 }
    }, options(control));
    rejectedAtomically(server, () => control.rollbackConfigChange('demo', changedValue.changeId, options(control)), /must be <= 500/);
    const removedConstraint = control.setSignal('demo', KEY, { description: 'Delay' }, options(control));
    control.setValue('demo', KEY, 1000, ['client'], options(control));
    rejectedAtomically(server, () => control.rollbackConfigChange('demo', removedConstraint.changeId, options(control)), /must be <= 500/);
    assert.equal(reports.length, 0);
    control.setValue('demo', KEY, 100, ['client'], options(control));
    control.rollbackConfigChange('demo', removedConstraint.changeId, options(control));
    assert.equal(control.getCatalog('demo').signals[KEY].constraint.max, 500);
    control.rollbackConfigChange('demo', constrained.changeId, options(control));
    assert.equal(control.getCatalog('demo').signals[KEY], undefined);
  } finally {
    await server.wardx.stop();
  }
});

test('persisted constraints survive restart and reject invalid authoritative state', async () => {
  const config = testServerConfig();
  const server = createIngestServer(config);
  const control = server.wardx.control;
  control.setSignal('demo', KEY, { description: 'Delay', constraint: CONSTRAINT }, options(control));
  await server.wardx.stop();
  const restarted = createIngestServer(config);
  assert.deepEqual(restarted.wardx.control.getCatalog('demo').signals[KEY].constraint, CONSTRAINT);
  rejectedAtomically(restarted, () => restarted.wardx.control.setValue('demo', KEY, -1, ['client'], options(restarted.wardx.control)), /must be >= 0/);
  await restarted.wardx.stop();

  const db = new Database(config.sqlite.path);
  try {
    const row = db.prepare('SELECT state_json FROM project_state WHERE project = ?').get('demo');
    const state = JSON.parse(row.state_json);
    state.values[KEY] = -1;
    db.prepare('UPDATE project_state SET state_json = ? WHERE project = ?').run(JSON.stringify(state), 'demo');
  } finally {
    db.close();
  }
  assert.throws(() => createIngestServer(config), /values.message.delayMs must be >= 0/);
});
