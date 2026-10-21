import { readFileSync } from 'node:fs';
import { validateCatalog } from './control/catalog.js';
import { validateConfigConstraints } from './control/configConstraints.js';
import { validateConfigRules } from './config/rules.js';
import { requireKeys } from './requireKeys.js';
import { validateKeyRoles } from './roles.js';
import { assertUnambiguousGoalMetrics, validateExperiment } from './control/validateExperiment.js';
import { CredentialRegistry } from './auth/CredentialRegistry.js';

// Conventional settings: a configuration supplies credentials, projects and
// only the values it changes. Each group merges over its defaults, and the
// default keys define each group's closed schema.
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  sink: 'null',
  maxRequestBytes: 2097152,
  maxClockSkewMs: 300000,
  maxFramesPerEnvelope: 256,
  maxItemsPerEnvelope: 10000,
  maxNameBytes: 256,
  maxDimensionKeys: 8,
  maxDimensionValueLength: 64,
  maxAttributeKeys: 32,
  maxAttributeValueLength: 1024,
  persistenceFlushIntervalMs: 250,
  aggregateRetentionMinutes: 60,
  aggregateMaxSeriesPerMetric: 1000,
  memorySinkMaxEnvelopes: 10000,
  recentClientsMax: 100,
  recentEventsMax: 1000,
  recentLogsMax: 200
};
const GROUP_DEFAULTS = {
  diagnostics: { sink: 'stderr' },
  readiness: { probeIntervalMs: 10000, probeTimeoutMs: 50, maxPersistenceLagMs: 60000 },
  sqlite: {
    path: 'wardx.sqlite',
    journalMode: 'WAL',
    synchronous: 'FULL',
    busyTimeoutMs: 5000,
    walAutoCheckpointPages: 1000,
    checkpointMode: 'PASSIVE',
    maxWriteBatchRows: 1000,
    transactionTimeoutMs: 5000,
    maxPendingBatches: 32,
    maxPendingBytes: 67108864
  },
  history: {
    clockSkewAllowanceMs: 300000,
    maxAcceptedPastAgeMs: 3600000,
    aggregateHourlyRetentionHours: 720,
    aggregateDailyRetentionDays: 365,
    maxAppVersionsPerProjectRoleTier: 20,
    maxQueryBuckets: 744,
    maxQueryRows: 10000,
    compactionIntervalMs: 60000
  },
  control: { journalCapacity: 1000, maxConcurrentMcpReads: 8, maxPendingMcpReads: 32 },
  mcpHttp: { enabled: false },
  capacity: { maxConcurrentSyncHandlers: 256, syncBodyTimeoutMs: 30000 },
  retention: { maxUsersPerProject: 1000000, maxChannelsPerProject: 64, maxGoalsPerProject: 16, maxQueryDays: 366 },
  experiments: { ledgerMaxRows: 1000000 }
};
const MCP_HTTP_DEFAULTS = {
  enabled: true,
  path: '/mcp',
  bearerTokenEnvironmentVariable: 'WARDX_MCP_TOKEN',
  maxRequestBytes: 65536,
  maxConcurrentRequests: 8,
  bodyTimeoutMs: 30000
};

const REQUIRED = ['credentials', 'projects'];
const REQUIRED_PROJECT = ['version', 'values', 'keyRoles', 'experiments'];
const ALLOWED = new Set([
  ...REQUIRED,
  ...Object.keys(DEFAULTS),
  ...Object.keys(GROUP_DEFAULTS),
  'ndjsonPath',
  'configPath'
]);
const ALLOWED_PROJECT = new Set([...REQUIRED_PROJECT, 'catalog', 'keyRules']);

const SQLITE_KEYS = Object.keys(GROUP_DEFAULTS.sqlite);
const HISTORY_KEYS = Object.keys(GROUP_DEFAULTS.history);
const CONTROL_KEYS = Object.keys(GROUP_DEFAULTS.control);
const MCP_HTTP_KEYS = Object.keys(MCP_HTTP_DEFAULTS);
const CAPACITY_KEYS = Object.keys(GROUP_DEFAULTS.capacity);
const READINESS_KEYS = Object.keys(GROUP_DEFAULTS.readiness);
const RETENTION_KEYS = Object.keys(GROUP_DEFAULTS.retention);
const EXPERIMENTS_KEYS = Object.keys(GROUP_DEFAULTS.experiments);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withDefaults(input) {
  if (!isObject(input)) throw new Error('server config must be an object');
  const config = { ...DEFAULTS, ...input };
  for (const [key, defaults] of Object.entries(GROUP_DEFAULTS)) {
    const value = input[key];
    if (value === undefined || value === null) config[key] = { ...defaults };
    else if (isObject(value)) config[key] = { ...defaults, ...value };
  }
  if (config.mcpHttp.enabled === true) config.mcpHttp = { ...MCP_HTTP_DEFAULTS, ...config.mcpHttp };
  return config;
}

function validateClosedObject(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  requireKeys(value, required, label);
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} unknown key: ${key}`);
  }
}

function validatePositiveIntegers(value, keys, label) {
  for (const key of keys) {
    if (!Number.isInteger(value[key]) || value[key] < 1) {
      throw new Error(`${label}.${key} must be an integer >= 1`);
    }
  }
}

function validateCredentials(credentials, projects) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('server config credentials must be an object');
  }
  if (Object.keys(credentials).length === 0) {
    throw new Error('server config credentials must contain at least one credential');
  }
  new CredentialRegistry(credentials);
  for (const credential of Object.values(credentials)) {
    if (!Object.prototype.hasOwnProperty.call(projects, credential.project)) {
      throw new Error(`server config projects missing entry for ${credential.project}`);
    }
  }
}

function validateMcpHttp(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('server config.mcpHttp must be an object');
  }
  if (typeof config.enabled !== 'boolean') {
    throw new Error('server config.mcpHttp.enabled must be a boolean');
  }
  if (!config.enabled) {
    validateClosedObject(config, ['enabled'], 'server config.mcpHttp');
    return;
  }
  validateClosedObject(config, MCP_HTTP_KEYS, 'server config.mcpHttp');
  if (
    typeof config.path !== 'string' ||
    !config.path.startsWith('/') ||
    config.path.includes('?') ||
    config.path.includes('#')
  ) {
    throw new Error('server config.mcpHttp.path must be an absolute URL path without query or fragment');
  }
  if (['/health', '/ready', '/v1/sync'].includes(config.path)) {
    throw new Error('server config.mcpHttp.path must not overlap an ingest route');
  }
  if (
    typeof config.bearerTokenEnvironmentVariable !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.bearerTokenEnvironmentVariable)
  ) {
    throw new Error('server config.mcpHttp.bearerTokenEnvironmentVariable must be an environment variable name');
  }
  validatePositiveIntegers(
    config,
    ['maxRequestBytes', 'maxConcurrentRequests', 'bodyTimeoutMs'],
    'server config.mcpHttp'
  );
}

function validateProjectSnapshot(snapshot, label) {
  requireKeys(snapshot, REQUIRED_PROJECT, label);
  for (const key of Object.keys(snapshot)) {
    if (!ALLOWED_PROJECT.has(key)) throw new Error(`${label} unknown key: ${key}`);
  }
  if (typeof snapshot.version !== 'number' || !Number.isFinite(snapshot.version)) {
    throw new Error(`${label}.version must be a finite number`);
  }
  if (typeof snapshot.values !== 'object' || snapshot.values === null || Array.isArray(snapshot.values)) {
    throw new Error(`${label}.values must be an object`);
  }
  if (!Array.isArray(snapshot.experiments)) {
    throw new Error(`${label}.experiments must be an array`);
  }
  validateKeyRoles(snapshot.values, snapshot.keyRoles, label);
  validateConfigRules(snapshot.values, snapshot.keyRules, label);
  for (const experiment of snapshot.experiments) validateExperiment(experiment);
  assertUnambiguousGoalMetrics(snapshot.experiments);
  if (snapshot.catalog !== undefined) validateCatalog(snapshot.catalog, `${label}.catalog`);
  validateConfigConstraints(snapshot, snapshot.catalog, label);
}

export function loadServerConfig(path) {
  if (!path) {
    throw new Error('config path is required');
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Wardx server config file is missing at ${path}`);
  }
  const parsed = JSON.parse(raw);
  const config = validateServerConfig(parsed);
  config.configPath = path;
  return config;
}

export function validateServerConfig(input) {
  const parsed = withDefaults(input);
  requireKeys(parsed, REQUIRED, 'server config');
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED.has(key)) throw new Error(`server config unknown key: ${key}`);
  }
  if (typeof parsed.host !== 'string' || parsed.host.length === 0) {
    throw new Error('server config host must be a non-empty string');
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) {
    throw new Error('server config port must be an integer 0-65535');
  }
  if (!['null', 'memory', 'ndjson'].includes(parsed.sink)) {
    throw new Error('server config sink must be null, memory, or ndjson');
  }
  if (parsed.sink === 'ndjson') {
    if (typeof parsed.ndjsonPath !== 'string' || parsed.ndjsonPath.length === 0) {
      throw new Error('server config ndjsonPath is required when sink is ndjson');
    }
  }
  if (!Number.isInteger(parsed.maxRequestBytes) || parsed.maxRequestBytes < 1) {
    throw new Error('server config maxRequestBytes must be an integer >= 1');
  }
  for (const key of [
    'maxClockSkewMs',
    'maxFramesPerEnvelope',
    'maxItemsPerEnvelope',
    'maxNameBytes',
    'maxDimensionKeys',
    'maxDimensionValueLength',
    'maxAttributeKeys',
    'maxAttributeValueLength',
    'persistenceFlushIntervalMs'
  ]) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < 1) {
      throw new Error(`server config ${key} must be an integer >= 1`);
    }
  }
  if (
    !parsed.diagnostics ||
    typeof parsed.diagnostics !== 'object' ||
    Array.isArray(parsed.diagnostics) ||
    !['none', 'stderr'].includes(parsed.diagnostics.sink)
  ) {
    throw new Error('server config diagnostics.sink must be none or stderr');
  }
  for (const key of Object.keys(parsed.diagnostics)) {
    if (key !== 'sink') throw new Error(`server config diagnostics unknown key: ${key}`);
  }
  if (!Number.isInteger(parsed.aggregateRetentionMinutes) || parsed.aggregateRetentionMinutes < 1) {
    throw new Error('server config aggregateRetentionMinutes must be an integer >= 1');
  }
  if (!Number.isInteger(parsed.aggregateMaxSeriesPerMetric) || parsed.aggregateMaxSeriesPerMetric < 1) {
    throw new Error('server config aggregateMaxSeriesPerMetric must be an integer >= 1');
  }
  if (!Number.isInteger(parsed.memorySinkMaxEnvelopes) || parsed.memorySinkMaxEnvelopes < 1) {
    throw new Error('server config memorySinkMaxEnvelopes must be an integer >= 1');
  }
  if (!Number.isInteger(parsed.recentClientsMax) || parsed.recentClientsMax < 1) {
    throw new Error('server config recentClientsMax must be an integer >= 1');
  }
  if (!Number.isInteger(parsed.recentEventsMax) || parsed.recentEventsMax < 1) {
    throw new Error('server config recentEventsMax must be an integer >= 1');
  }
  if (!Number.isInteger(parsed.recentLogsMax) || parsed.recentLogsMax < 1) {
    throw new Error('server config recentLogsMax must be an integer >= 1');
  }
  validateClosedObject(parsed.sqlite, SQLITE_KEYS, 'server config.sqlite');
  if (typeof parsed.sqlite.path !== 'string' || parsed.sqlite.path.length === 0) {
    throw new Error('server config.sqlite.path must be a non-empty string');
  }
  if (parsed.sqlite.journalMode !== 'WAL') {
    throw new Error('server config.sqlite.journalMode must be WAL');
  }
  if (!['OFF', 'NORMAL', 'FULL', 'EXTRA'].includes(parsed.sqlite.synchronous)) {
    throw new Error('server config.sqlite.synchronous must be OFF, NORMAL, FULL, or EXTRA');
  }
  if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(parsed.sqlite.checkpointMode)) {
    throw new Error('server config.sqlite.checkpointMode must be PASSIVE, FULL, RESTART, or TRUNCATE');
  }
  validatePositiveIntegers(
    parsed.sqlite,
    [
      'busyTimeoutMs',
      'walAutoCheckpointPages',
      'maxWriteBatchRows',
      'transactionTimeoutMs',
      'maxPendingBatches',
      'maxPendingBytes'
    ],
    'server config.sqlite'
  );
  validateClosedObject(parsed.retention, RETENTION_KEYS, 'server config.retention');
  validatePositiveIntegers(parsed.retention, RETENTION_KEYS, 'server config.retention');
  validateClosedObject(parsed.history, HISTORY_KEYS, 'server config.history');
  validatePositiveIntegers(parsed.history, HISTORY_KEYS, 'server config.history');
  validateClosedObject(parsed.control, CONTROL_KEYS, 'server config.control');
  validatePositiveIntegers(parsed.control, CONTROL_KEYS, 'server config.control');
  validateMcpHttp(parsed.mcpHttp);
  validateClosedObject(parsed.readiness, READINESS_KEYS, 'server config.readiness');
  validatePositiveIntegers(parsed.readiness, READINESS_KEYS, 'server config.readiness');
  for (const key of READINESS_KEYS) {
    if (!Number.isSafeInteger(parsed.readiness[key])) {
      throw new Error(`server config.readiness.${key} must be a safe integer`);
    }
  }
  for (const key of ['probeIntervalMs', 'probeTimeoutMs']) {
    if (parsed.readiness[key] > 2_147_483_647) {
      throw new Error(`server config.readiness.${key} exceeds the timer range`);
    }
  }
  validateClosedObject(parsed.capacity, CAPACITY_KEYS, 'server config.capacity');
  validatePositiveIntegers(parsed.capacity, CAPACITY_KEYS, 'server config.capacity');
  validateClosedObject(parsed.experiments, EXPERIMENTS_KEYS, 'server config.experiments');
  validatePositiveIntegers(parsed.experiments, EXPERIMENTS_KEYS, 'server config.experiments');
  if (typeof parsed.projects !== 'object' || parsed.projects === null || Array.isArray(parsed.projects)) {
    throw new Error('server config projects must be an object');
  }
  if (Object.keys(parsed.projects).length === 0) {
    throw new Error('server config projects must contain at least one project');
  }
  for (const [name, snapshot] of Object.entries(parsed.projects)) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('server config projects keys must be non-empty strings');
    }
    validateProjectSnapshot(snapshot, `server config.projects.${name}`);
  }
  const reservedExperimentRows = Object.values(parsed.projects)
    .flatMap((project) => project.experiments)
    .filter((experiment) => experiment.enabled && experiment.targetSampleSizePerVariant !== undefined)
    .reduce(
      (total, experiment) => total + experiment.targetSampleSizePerVariant * experiment.variants.length,
      0
    );
  if (reservedExperimentRows > parsed.experiments.ledgerMaxRows) {
    throw new Error(
      `server config experiment plans reserve ${reservedExperimentRows} ledger rows, exceeding ${parsed.experiments.ledgerMaxRows}`
    );
  }
  validateCredentials(parsed.credentials, parsed.projects);
  return parsed;
}
