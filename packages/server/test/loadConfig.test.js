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
  assert.equal(config.credentials.dev_project_key.project, 'demo');
  assert.deepEqual(config.credentials.dev_project_key.allowedRoles, ['client', 'game-server']);
  assert.equal(config.projects.demo.version, 1);
  assert.equal(config.recentEventsMax, 1000);
  assert.deepEqual(config.projects.demo.catalog.inspectEvents, ['purchase']);
  assert.equal(config.recentLogsMax, 200);
  assert.equal(config.aggregateMaxSeriesPerMetric, 1000);
  assert.equal(config.configPath, path);
  assert.equal(config.adminKey, undefined);
});

test('validateServerConfig needs only credentials and projects', () => {
  const { credentials, projects } = testServerConfig();
  const config = validateServerConfig({ credentials, projects });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.sink, 'null');
  assert.equal(config.sqlite.path, 'wardx.sqlite');
  assert.equal(config.sqlite.synchronous, 'FULL');
  assert.deepEqual(config.retention, {
    maxUsersPerProject: 1000000, maxChannelsPerProject: 64, maxGoalsPerProject: 16, maxQueryDays: 366
  });
  assert.deepEqual(config.mcpHttp, { enabled: false });

  assert.throws(() => validateServerConfig({ projects }), /missing required keys: credentials/);
  assert.throws(() => validateServerConfig({ credentials }), /missing required keys: projects/);
  assert.throws(() => validateServerConfig(null), /server config must be an object/);
});

test('validateServerConfig merges each group over its defaults without mutating the input', () => {
  const { credentials, projects } = testServerConfig();
  const input = { credentials, projects, retention: { maxGoalsPerProject: 4 }, sqlite: { synchronous: 'NORMAL' } };
  const snapshot = structuredClone(input);
  const config = validateServerConfig(input);
  assert.equal(config.retention.maxGoalsPerProject, 4);
  assert.equal(config.retention.maxUsersPerProject, 1000000);
  assert.equal(config.sqlite.synchronous, 'NORMAL');
  assert.equal(config.sqlite.journalMode, 'WAL');
  assert.deepEqual(input, snapshot);
  assert.throws(
    () => validateServerConfig({ credentials, projects, retention: { maxGoals: 4 } }),
    /retention unknown key: maxGoals/
  );
});

test('validateServerConfig defaults an omitted aggregateMaxSeriesPerMetric', () => {
  const config = testServerConfig();
  delete config.aggregateMaxSeriesPerMetric;
  assert.equal(validateServerConfig(config).aggregateMaxSeriesPerMetric, 1000);
});

test('validateServerConfig defaults and bounds the recent event capacity', () => {
  const missing = testServerConfig();
  delete missing.recentEventsMax;
  assert.equal(validateServerConfig(missing).recentEventsMax, 1000);

  assert.throws(
    () => validateServerConfig(testServerConfig({ recentEventsMax: 0 })),
    /recentEventsMax must be an integer >= 1/
  );
});

test('loadServerConfig reads production.json with a null sink', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../../config/production.json');
  const config = loadServerConfig(path);
  assert.equal(config.sink, 'null');
  assert.equal(config.aggregateMaxSeriesPerMetric, 1000);
});

test('validateServerConfig requires a project entry for each credential', () => {
  const config = testServerConfig();
  config.credentials['test-key'].project = 'missing';
  assert.throws(
    () => validateServerConfig(config),
    /projects missing entry for missing/
  );
});

test('validateServerConfig requires scoped credential and capacity records', () => {
  const credential = testServerConfig();
  credential.credentials['test-key'].allowedRoles = [];
  assert.throws(() => validateServerConfig(credential), /allowedRoles must be a non-empty array/);

  const sqlite = testServerConfig();
  delete sqlite.sqlite.maxPendingBytes;
  assert.equal(validateServerConfig(sqlite).sqlite.maxPendingBytes, 67108864);
  sqlite.sqlite.maxPendingBytes = 0;
  assert.throws(() => validateServerConfig(sqlite), /maxPendingBytes must be an integer >= 1/);

  const history = testServerConfig();
  history.history.maxQueryRows = 0;
  assert.throws(() => validateServerConfig(history), /maxQueryRows must be an integer >= 1/);
});

test('validateServerConfig defaults and bounds MCP HTTP configuration', () => {
  const missing = testServerConfig();
  delete missing.mcpHttp;
  assert.deepEqual(validateServerConfig(missing).mcpHttp, { enabled: false });

  assert.doesNotThrow(() => validateServerConfig(testServerConfig({ mcpHttp: { enabled: false } })));

  const enabled = {
    enabled: true,
    path: '/mcp',
    bearerTokenEnvironmentVariable: 'WARDX_MCP_TOKEN',
    maxRequestBytes: 65536,
    maxConcurrentRequests: 8,
    bodyTimeoutMs: 30000
  };
  assert.doesNotThrow(() => validateServerConfig(testServerConfig({ mcpHttp: enabled })));
  assert.deepEqual(validateServerConfig(testServerConfig({ mcpHttp: { enabled: true } })).mcpHttp, enabled);
  assert.throws(
    () => validateServerConfig(testServerConfig({ mcpHttp: { path: '/agents' } })),
    /mcpHttp unknown key: path/
  );

  for (const key of ['host', 'port', 'allowedHosts', 'allowedOrigins']) {
    assert.throws(
      () => validateServerConfig(testServerConfig({ mcpHttp: { ...enabled, [key]: [] } })),
      new RegExp(`mcpHttp unknown key: ${key}`)
    );
  }
  for (const path of ['/health', '/ready', '/v1/sync']) {
    assert.throws(
      () => validateServerConfig(testServerConfig({ mcpHttp: { ...enabled, path } })),
      /mcpHttp\.path must not overlap an ingest route/
    );
  }

  assert.throws(
    () => validateServerConfig(testServerConfig({ mcpHttp: { ...enabled, extra: true } })),
    /mcpHttp unknown key: extra/
  );
  const bearerToken = 'wardx-config-test-token-at-least-32-bytes';
  assert.equal(
    validateServerConfig(testServerConfig({ mcpHttp: { enabled: true, bearerToken } })).mcpHttp.bearerToken,
    bearerToken
  );
  for (const short of ['short', 42]) {
    assert.throws(
      () => validateServerConfig(testServerConfig({ mcpHttp: { enabled: true, bearerToken: short } })),
      /mcpHttp\.bearerToken must contain at least 32 bytes/
    );
  }
  assert.throws(
    () => validateServerConfig(testServerConfig({ mcpHttp: { ...enabled, maxConcurrentRequests: 0 } })),
    /maxConcurrentRequests must be an integer >= 1/
  );
});

test('validateServerConfig reserves fixed-horizon ledger capacity before enablement', () => {
  const config = testServerConfig();
  config.experiments.ledgerMaxRows = 1;
  config.projects.demo.experiments = [{
    id: 'capacity-v1',
    enabled: true,
    allocation: 1,
    salt: 'capacity-v1',
    goalMetric: 'message.sent',
    assignmentUnitKind: 'subject',
    outcomeKind: 'conversion',
    control: 'control',
    targetSampleSizePerVariant: 1,
    earliestAnalysisAt: 0,
    familyWiseAlpha: 0.05,
    minimumEffect: 0,
    direction: 'increase',
    terminalRetentionMs: 1000,
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
    roles: ['client'],
    variants: [
      { key: 'control', weight: 1, values: {} },
      { key: 'test', weight: 1, values: {} }
    ]
  }];
  assert.throws(() => validateServerConfig(config), /reserve 2 ledger rows, exceeding 1/);
});

test('validateServerConfig rejects an invalid catalog', () => {
  const config = testServerConfig();
  config.projects.demo.catalog = { signals: { 'message.sent': 1 } };
  assert.throws(() => validateServerConfig(config), /signals\.message\.sent must be an object/);

  config.projects.demo.catalog = {
    signals: { 'message.sent': { description: 'Messages sent', category: '' } }
  };
  assert.throws(() => validateServerConfig(config), /signals\.message\.sent\.category must be a non-empty string/);

  config.projects.demo.catalog = {
    signals: { 'message.sent': { description: 'Messages sent', owner: 'growth' } }
  };
  assert.throws(() => validateServerConfig(config), /signals\.message\.sent unknown key: owner/);
});

test('validateServerConfig rejects a duplicate persistLogs name', () => {
  const config = testServerConfig();
  config.projects.demo.catalog = { persistLogs: ['payment_failed', 'payment_failed'] };
  assert.throws(() => validateServerConfig(config), /persistLogs duplicate name: payment_failed/);
});

test('validateServerConfig rejects invalid inspectEvents entries', () => {
  const duplicate = testServerConfig();
  duplicate.projects.demo.catalog = { inspectEvents: ['purchase', 'purchase'] };
  assert.throws(() => validateServerConfig(duplicate), /inspectEvents duplicate name: purchase/);

  const empty = testServerConfig();
  empty.projects.demo.catalog = { inspectEvents: [''] };
  assert.throws(() => validateServerConfig(empty), /inspectEvents\[0\] must be a non-empty string/);
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
    assignmentUnitKind: 'subject',
    terminalRetentionMs: 604800000,
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
