import { readFileSync } from 'node:fs';
import { validateCatalog } from './control/catalog.js';
import { requireKeys } from './requireKeys.js';
import { validateKeyRoles } from './roles.js';
import { assertUnambiguousGoalMetrics, validateExperiment } from './control/validateExperiment.js';

const REQUIRED = [
  'host',
  'port',
  'projectKeys',
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
  'recentLogsMax',
  'projects'
];

const REQUIRED_PROJECT = ['version', 'values', 'keyRoles', 'experiments'];
const ALLOWED = new Set([...REQUIRED, 'ndjsonPath', 'configPath']);
const ALLOWED_PROJECT = new Set([...REQUIRED_PROJECT, 'catalog']);

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
  if (typeof parsed.projectKeys !== 'object' || parsed.projectKeys === null || Array.isArray(parsed.projectKeys)) {
    throw new Error('server config projectKeys must be an object');
  }
  if (Object.keys(parsed.projectKeys).length === 0) {
    throw new Error('server config projectKeys must contain at least one key');
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
  if (!Number.isInteger(parsed.recentLogsMax) || parsed.recentLogsMax < 1) {
    throw new Error('server config recentLogsMax must be an integer >= 1');
  }
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
  for (const [key, name] of Object.entries(parsed.projectKeys)) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('server config projectKeys keys must be non-empty strings');
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('server config projectKeys values must be non-empty strings');
    }
    if (!Object.prototype.hasOwnProperty.call(parsed.projects, name)) {
      throw new Error(`server config projects missing entry for ${name}`);
    }
  }
  return parsed;
}
