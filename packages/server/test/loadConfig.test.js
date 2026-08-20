import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from '../src/loadConfig.js';

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
});
