import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadServerConfig, validateServerConfig } from '../src/loadConfig.js';
import { testServerConfig } from './helpers.js';

test('loadServerConfig requires a path', () => {
  assert.throws(() => loadServerConfig(), /config path is required/);
  assert.throws(() => loadServerConfig(''), /config path is required/);
});

test('loadServerConfig reads a JSON file', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../../config/development.json');
  const config = loadServerConfig(path);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.projectKeys.dev_project_key, 'demo');
  assert.equal(config.projects.demo.version, 1);
  assert.equal(config.recentLogsMax, 200);
  assert.equal(config.aggregateMaxSeriesPerMetric, 1000);
  assert.equal(config.configPath, path);
  assert.equal(config.adminKey, undefined);
});

test('validateServerConfig requires aggregateMaxSeriesPerMetric', () => {
  const config = testServerConfig();
  delete config.aggregateMaxSeriesPerMetric;
  assert.throws(() => validateServerConfig(config), /aggregateMaxSeriesPerMetric/);
});

test('loadServerConfig reads production.json with a null sink', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../../config/production.json');
  const config = loadServerConfig(path);
  assert.equal(config.sink, 'null');
  assert.equal(config.aggregateMaxSeriesPerMetric, 1000);
});

test('validateServerConfig requires a project entry for each key', () => {
  assert.throws(
    () => validateServerConfig(testServerConfig({ projectKeys: { 'test-key': 'missing' } })),
    /projects missing entry for missing/
  );
});

test('validateServerConfig rejects an invalid catalog', () => {
  const config = testServerConfig();
  config.projects.demo.catalog = { signals: { 'message.sent': 1 } };
  assert.throws(() => validateServerConfig(config), /signals\.message\.sent must be a non-empty string/);
});

test('validateServerConfig rejects a duplicate persistLogs name', () => {
  const config = testServerConfig();
  config.projects.demo.catalog = { persistLogs: ['payment_failed', 'payment_failed'] };
  assert.throws(() => validateServerConfig(config), /persistLogs duplicate name: payment_failed/);
});

test('validateServerConfig rejects unknown server, diagnostics, and project keys', () => {
  const top = testServerConfig();
  top.extra = true;
  assert.throws(() => validateServerConfig(top), /server config unknown key: extra/);

  const diagnostics = testServerConfig();
  diagnostics.diagnostics.extra = true;
  assert.throws(() => validateServerConfig(diagnostics), /diagnostics unknown key: extra/);

  const project = testServerConfig();
  project.projects.demo.extra = true;
  assert.throws(() => validateServerConfig(project), /projects\.demo unknown key: extra/);
});

test('validateServerConfig requires goalMetric and rejects overlapping enabled goals', () => {
  const experiment = {
    id: 'delay-v1',
    enabled: true,
    allocation: 1,
    salt: 'delay-v1',
    goalMetric: 'message.sent',
    roles: ['client'],
    variants: [{ key: 'control', weight: 1, values: { 'message.delayMs': 1000 } }]
  };
  const missing = testServerConfig();
  missing.projects.demo.experiments = [{ ...experiment, goalMetric: undefined }];
  assert.throws(() => validateServerConfig(missing), /experiment\.goalMetric is required/);

  const ambiguous = testServerConfig();
  ambiguous.projects.demo.experiments = [
    experiment,
    { ...experiment, id: 'delay-v2', salt: 'delay-v2' }
  ];
  assert.throws(() => validateServerConfig(ambiguous), /share goalMetric message\.sent for overlapping roles/);
});
