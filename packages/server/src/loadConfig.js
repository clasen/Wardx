import { readFileSync } from 'node:fs';
import { validateCatalog } from './control/catalog.js';
import { requireKeys } from './requireKeys.js';
import { validateKeyRoles } from './roles.js';
import { assertUnambiguousGoalMetrics, validateExperiment } from './control/validateExperiment.js';
import { CredentialRegistry } from './auth/CredentialRegistry.js';

const REQUIRED = [
  'host',
  'port',
  'credentials',
  'sink',
  'maxRequestBytes',
  'maxClockSkewMs',
  'maxFramesPerEnvelope',
  'maxItemsPerEnvelope',
  'maxNameBytes',
  'maxDimensionKeys',
  'maxDimensionValueLength',
  'maxAttributeKeys',
  'maxAttributeValueLength',
  'persistenceFlushIntervalMs',
  'diagnostics',
  'aggregateRetentionMinutes',
  'aggregateMaxSeriesPerMetric',
  'memorySinkMaxEnvelopes',
  'recentClientsMax',
  'recentEventsMax',
  'recentLogsMax',
  'sqlite',
  'history',
  'control',
  'mcpHttp',
  'capacity',
  'experiments',
  'projects'
];

const REQUIRED_PROJECT = ['version', 'values', 'keyRoles', 'experiments'];
const ALLOWED = new Set([...REQUIRED, 'ndjsonPath', 'configPath']);
const ALLOWED_PROJECT = new Set([...REQUIRED_PROJECT, 'catalog']);

const REQUIRED_SQLITE = [
  'path',
  'journalMode',
  'synchronous',
  'busyTimeoutMs',
  'walAutoCheckpointPages',
  'checkpointMode',
  'maxWriteBatchRows',
  'transactionTimeoutMs',
  'maxPendingBatches',
  'maxPendingBytes'
];
const REQUIRED_HISTORY = [
  'clockSkewAllowanceMs',
  'maxAcceptedPastAgeMs',
  'aggregateHourlyRetentionHours',
  'aggregateDailyRetentionDays',
  'maxAppVersionsPerProjectRoleTier',
  'maxQueryBuckets',
  'maxQueryRows',
  'compactionIntervalMs'
];
const REQUIRED_CONTROL = ['journalCapacity', 'maxConcurrentMcpReads', 'maxPendingMcpReads'];
const REQUIRED_MCP_HTTP = [
  'enabled',
  'host',
  'port',
  'path',
  'bearerTokenEnvironmentVariable',
  'maxRequestBytes',
  'maxConcurrentRequests',
  'allowedHosts',
  'allowedOrigins'
];
const REQUIRED_CAPACITY = ['maxConcurrentSyncHandlers'];
const REQUIRED_EXPERIMENTS = ['ledgerMaxRows'];

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

function validateStringArray(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    if (seen.has(value)) throw new Error(`${label} duplicate entry: ${value}`);
    seen.add(value);
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
  validateClosedObject(config, REQUIRED_MCP_HTTP, 'server config.mcpHttp');
  if (!['127.0.0.1', '::1'].includes(config.host)) {
    throw new Error('server config.mcpHttp.host must be a loopback address');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('server config.mcpHttp.port must be an integer 0-65535');
  }
  if (
    typeof config.path !== 'string' ||
    !config.path.startsWith('/') ||
    config.path.includes('?') ||
    config.path.includes('#')
  ) {
    throw new Error('server config.mcpHttp.path must be an absolute URL path without query or fragment');
  }
  if (
    typeof config.bearerTokenEnvironmentVariable !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.bearerTokenEnvironmentVariable)
  ) {
    throw new Error('server config.mcpHttp.bearerTokenEnvironmentVariable must be an environment variable name');
  }
  validatePositiveIntegers(
    config,
    ['maxRequestBytes', 'maxConcurrentRequests'],
    'server config.mcpHttp'
  );
  validateStringArray(config.allowedHosts, 'server config.mcpHttp.allowedHosts');
  validateStringArray(config.allowedOrigins, 'server config.mcpHttp.allowedOrigins');
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  for (const host of config.allowedHosts) {
    if (!loopbackHosts.has(host)) {
      throw new Error('server config.mcpHttp.allowedHosts entries must be loopback hostnames');
    }
  }
  for (const origin of config.allowedOrigins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('server config.mcpHttp.allowedOrigins entries must be HTTP loopback origins');
    }
    const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    if (
      parsed.protocol !== 'http:' ||
      !loopbackHosts.has(hostname.toLowerCase()) ||
      parsed.origin !== origin
    ) {
      throw new Error('server config.mcpHttp.allowedOrigins entries must be HTTP loopback origins');
    }
  }
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
  for (const experiment of snapshot.experiments) validateExperiment(experiment);
  assertUnambiguousGoalMetrics(snapshot.experiments);
  if (snapshot.catalog !== undefined) validateCatalog(snapshot.catalog, `${label}.catalog`);
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

export function validateServerConfig(parsed) {
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
  validateClosedObject(parsed.sqlite, REQUIRED_SQLITE, 'server config.sqlite');
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
  validateClosedObject(parsed.history, REQUIRED_HISTORY, 'server config.history');
  validatePositiveIntegers(parsed.history, REQUIRED_HISTORY, 'server config.history');
  validateClosedObject(parsed.control, REQUIRED_CONTROL, 'server config.control');
  validatePositiveIntegers(parsed.control, REQUIRED_CONTROL, 'server config.control');
  validateMcpHttp(parsed.mcpHttp);
  validateClosedObject(parsed.capacity, REQUIRED_CAPACITY, 'server config.capacity');
  validatePositiveIntegers(parsed.capacity, REQUIRED_CAPACITY, 'server config.capacity');
  validateClosedObject(parsed.experiments, REQUIRED_EXPERIMENTS, 'server config.experiments');
  validatePositiveIntegers(parsed.experiments, REQUIRED_EXPERIMENTS, 'server config.experiments');
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
