import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigRepository } from '../src/config/ConfigRepository.js';
import { resolveConfigRules, validateConfigRules } from '../src/config/rules.js';
import { validateEnvelope } from '../src/ingest/validate.js';
import { validateServerConfig } from '../src/loadConfig.js';
import { executeTool } from '../src/mcp/tools.js';
import { createIngestServer } from '../src/server.js';
import { sampleEnvelope, testServerConfig } from './helpers.js';

const KEY = 'message.delayMs';
const rule = (field, op, value, result = 200) => ({ when: [{ field, op, value }], value: result });
const options = (control) => ({ expectedVersion: control.getConfig('demo').version, reason: 'test conditional config' });

test('rules use strict scalar comparisons, AND conditions, first match, and base on missing fields', () => {
  const values = { knob: 'base' };
  for (const [op, target, matching, other] of [
    ['eq', false, false, true], ['eq', 'eu', 'eu', 'us'],
    ['in', [1, 'eu', false], 'eu', 'us'],
    ['gt', 2, 3, 2], ['gte', 2, 2, 1], ['lt', 2, 1, 2], ['lte', 2, 2, 3]
  ]) {
    const rules = { knob: [rule('attributes.custom', op, target, 'matched')] };
    validateConfigRules(values, rules);
    const resolve = (attributes) => resolveConfigRules(values, rules, { attributes }).knob;
    assert.equal(resolve({ custom: matching }), 'matched');
    assert.equal(resolve({ custom: other }), 'base');
    assert.equal(resolve({}), 'base');
    assert.equal(resolve({ custom: null }), 'base');
    assert.equal(resolve(Object.create({ custom: matching })), 'base');
  }
  const first = rule('attributes.tier', 'lte', 2, 'first');
  first.when.push({ field: 'environment', op: 'eq', value: 'test' });
  const rules = { knob: [first, rule('attributes.tier', 'in', [1, 2, 3], 'second')] };
  assert.equal(resolveConfigRules(values, rules, { environment: 'test', attributes: { tier: 2 } }).knob, 'first');
  assert.equal(resolveConfigRules(values, rules, { environment: 'production', attributes: { tier: 2 } }).knob, 'second');
  assert.equal(resolveConfigRules(values, rules, { environment: 'test', attributes: { tier: '2' } }).knob, 'base');
  for (const field of ['role', 'appVersion', 'platform']) {
    assert.equal(resolveConfigRules(values, { knob: [rule(field, 'eq', 'x', false)] }, { [field]: 'x' }).knob, false);
  }
  const objectValues = { knob: { title: 'base', dismissible: true }, toString: 'ordinary key' };
  const objectRules = { knob: [rule('role', 'eq', 'client', { title: 'conditional' })] };
  assert.deepEqual(resolveConfigRules(objectValues, objectRules, { role: 'client' }), {
    knob: { title: 'conditional' }, toString: 'ordinary key'
  });
});

test('invalid rules fail at bootstrap instead of being silently ignored', () => {
  const invalid = [
    null, [], { missing: [] }, { [KEY]: null },
    { [KEY]: [{ when: [], value: 1 }] },
    { [KEY]: [{ when: [ { field: 'role', op: 'eq', value: 'client' } ] }] },
    { [KEY]: [rule('attributes.', 'eq', 1)] },
    { [KEY]: [rule('unknown', 'eq', 1)] },
    { [KEY]: [rule('role', 'contains', 'client')] },
    { [KEY]: [rule('role', 'eq', null)] },
    { [KEY]: [rule('role', 'in', [])] },
    { [KEY]: [rule('role', 'in', [{}])] },
    { [KEY]: [rule('attributes.tier', 'lt', '2')] },
    { [KEY]: [rule('attributes.tier', 'lt', Infinity)] },
    { [KEY]: [{ ...rule('role', 'eq', 'client'), extra: true }] }
  ];
  for (const keyRules of invalid) {
    const config = testServerConfig();
    config.projects.demo.keyRules = keyRules;
    assert.throws(() => validateServerConfig(config), /keyRules/);
  }
});

test('wire context tracks resolved values and role visibility without exposing rules or retaining per-client caches', () => {
  const config = testServerConfig().projects.demo;
  config.keyRules = { [KEY]: [rule('attributes.tier', 'lt', 2)] };
  const repo = new ConfigRepository(config);
  const client = { role: 'client', attributes: { tier: 1 } };
  const first = JSON.parse(repo.buildResponse(repo.version, client));
  assert.equal(first.config.values[KEY], 200);
  assert.equal(first.config.keyRules, undefined);
  assert.equal(JSON.parse(repo.buildResponse(repo.version, client, first.configContext)).config, undefined);
  client.attributes.unused = 'changed';
  assert.equal(JSON.parse(repo.buildResponse(repo.version, client, first.configContext)).config, undefined);
  client.attributes.tier = 3;
  const changed = JSON.parse(repo.buildResponse(repo.version, client, first.configContext));
  assert.equal(changed.configVersion, first.configVersion);
  assert.equal(changed.config.values[KEY], 1000);
  assert.notEqual(changed.configContext, first.configContext);
  const hidden = JSON.parse(repo.buildResponse(repo.version, { ...client, role: 'backend' }, changed.configContext));
  assert.deepEqual(hidden.config.values, {});
  assert.deepEqual(hidden.config.experiments, []);
  assert.equal(repo.roleViews.size, 2);
});

test('role caches reuse base snapshots, evaluate only visible rules, and invalidate on replacement', () => {
  const config = testServerConfig().projects.demo;
  config.values.internal = 'private';
  config.keyRoles.internal = ['backend'];
  config.keyRules = { internal: [rule('attributes.tier', 'lt', 2, 'conditional')] };
  config.experiments = [{
    id: 'delay', enabled: true, allocation: 1, salt: 'test',
    primaryMetric: 'message.sent', goalMetric: 'message.sent',
    assignmentUnitKind: 'subject', terminalRetentionMs: 604800000, roles: ['client'],
    variants: [{ key: 'control', weight: 1, values: { [KEY]: 1000 } }]
  }];
  const repo = new ConfigRepository(config);
  const client = { role: 'client', get attributes() { throw new Error('hidden rules must not be evaluated'); } };
  const original = repo._wireSnapshot(client);
  assert.strictEqual(repo._wireSnapshot(client), original);
  assert.deepEqual(JSON.parse(original.wire).values, { [KEY]: 1000, 'chat.enabled': true });
  assert.equal(JSON.parse(original.wire).experiments[0].id, 'delay');

  const backend = { role: 'backend', attributes: { tier: 3 } };
  const base = repo._wireSnapshot(backend);
  assert.deepEqual(JSON.parse(base.wire).experiments, []);
  assert.strictEqual(repo._wireSnapshot(backend), base);
  backend.attributes.tier = 1;
  assert.equal(JSON.parse(repo._wireSnapshot(backend).wire).values.internal, 'conditional');
  backend.attributes.tier = 3;
  assert.strictEqual(repo._wireSnapshot(backend), base);
  for (let tier = 0; tier < 100; tier++) repo.buildResponse(repo.version, { role: 'backend', attributes: { tier } });
  assert.equal(repo.roleViews.size, 2);

  config.values[KEY] = 900;
  config.keyRoles.internal = ['client'];
  config.keyRules = { [KEY]: [rule('attributes.tier', 'lt', 2, 300)] };
  config.experiments = [];
  repo.replace(config);
  const updated = repo._wireSnapshot({ role: 'client', attributes: { tier: 3 } });
  assert.notEqual(updated.context, original.context);
  assert.deepEqual(JSON.parse(updated.wire), { values: { [KEY]: 900, 'chat.enabled': true, internal: 'private' }, experiments: [] });
  assert.equal(JSON.parse(repo._wireSnapshot({ role: 'client', attributes: { tier: 1 } }).wire).values[KEY], 300);
});

test('client attributes and context are validated with configured ingest limits', () => {
  const limits = testServerConfig();
  const envelope = sampleEnvelope({ client: { attributes: { region: 'eu', tier: 2, enabled: false } } });
  assert.equal(validateEnvelope(envelope, limits), null);
  for (const attributes of [null, [], { x: null }, { x: {} }, { x: [] }, { x: Infinity }, { '': 1 }]) {
    assert.match(validateEnvelope({ ...envelope, client: { ...envelope.client, attributes } }, limits), /client.attributes/);
  }
  assert.match(validateEnvelope(envelope, { ...limits, maxAttributeKeys: 1 }), /at most 1 keys/);
  assert.match(validateEnvelope(envelope, { ...limits, maxAttributeValueLength: 1 }), /at most 1 characters/);
  assert.equal(validateEnvelope({ ...envelope, configContext: '0123456789abcdef' }, limits), null);
  for (const configContext of ['invalid', 'a'.repeat(64), '0123456789ABCDEF']) {
    assert.match(validateEnvelope({ ...envelope, configContext }, limits), /configContext/);
  }
});

test('MCP rules persist, preserve knob edits, validate constraints atomically, and support clear/delete/rollback', async () => {
  const config = testServerConfig();
  config.projects.demo.keyRules = { [KEY]: [rule('attributes.tier', 'lt', 2)] };
  let server = createIngestServer(config);
  try {
    const control = server.wardx.control;
    const rules = [rule('attributes.region', 'eq', 'eu', 300)];
    const write = (args) => executeTool(control, 'set_config_value', {
      project: 'demo', key: KEY, value: 1000, roles: ['client'], ...options(control), ...args
    });
    const change = write({ rules });
    write({ value: 900 });
    assert.deepEqual(control.getConfig('demo').keyRules[KEY], rules);
    assert.deepEqual(control.getOverview('demo').knobs.find((knob) => knob.key === KEY).rules, rules);
    const before = control.getConfig('demo');
    assert.throws(() => write({ rules: [rule('role', 'eq', null)] }), /scalar/);
    assert.deepEqual(control.getConfig('demo'), before);
    executeTool(control, 'set_signal', {
      project: 'demo', name: KEY, description: 'Delay', constraint: { type: 'integer', min: 0, max: 1000 }, ...options(control)
    });
    const constrained = control.getConfig('demo');
    assert.throws(() => write({ rules: [rule('role', 'eq', 'client', 1001)] }), /must be <= 1000/);
    assert.deepEqual(control.getConfig('demo'), constrained);
    const clear = write({ rules: [] });
    assert.equal(control.getConfig('demo').keyRules[KEY], undefined);
    control.rollbackConfigChange('demo', clear.changeId, options(control));
    assert.deepEqual(control.getConfig('demo').keyRules[KEY], rules);
    const deleted = control.deleteValue('demo', KEY, options(control));
    assert.equal(control.getConfig('demo').keyRules[KEY], undefined);
    control.rollbackConfigChange('demo', deleted.changeId, options(control));
    assert.deepEqual(control.getConfig('demo').keyRules[KEY], rules);
    assert.ok(control.listConfigChanges('demo').changes.some((entry) => entry.id === change.changeId));
    await server.wardx.stop();
    server = createIngestServer(config);
    assert.deepEqual(server.wardx.control.getConfig('demo').keyRules[KEY], rules);
    assert.equal(JSON.parse(server.wardx.registry.get('demo').configRepo.buildResponse(0, {
      role: 'client', attributes: { region: 'eu' }
    })).config.values[KEY], 300);
  } finally {
    await server.wardx.stop();
  }
});
