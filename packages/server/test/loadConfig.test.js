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
