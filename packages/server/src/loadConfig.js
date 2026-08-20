import { readFileSync } from 'node:fs';
import { requireKeys } from './requireKeys.js';

const REQUIRED = [
  'host',
  'port',
  'projectKeys',
  'adminKey',
  'sink',
  'maxRequestBytes',
  'aggregateRetentionMinutes',
  'memorySinkMaxEnvelopes',
  'config'
];

const REQUIRED_CONFIG = ['version', 'values', 'experiments'];

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
  return validateServerConfig(parsed);
}

export function validateServerConfig(parsed) {
  requireKeys(parsed, REQUIRED, 'server config');
  requireKeys(parsed.config, REQUIRED_CONFIG, 'server config.config');
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
  if (typeof parsed.adminKey !== 'string' || parsed.adminKey.length === 0) {
    throw new Error('server config adminKey must be a non-empty string');
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
  if (!Number.isInteger(parsed.aggregateRetentionMinutes) || parsed.aggregateRetentionMinutes < 1) {
    throw new Error('server config aggregateRetentionMinutes must be an integer >= 1');
  }
  if (!Number.isInteger(parsed.memorySinkMaxEnvelopes) || parsed.memorySinkMaxEnvelopes < 1) {
    throw new Error('server config memorySinkMaxEnvelopes must be an integer >= 1');
  }
  if (typeof parsed.config.version !== 'number' || !Number.isFinite(parsed.config.version)) {
    throw new Error('server config.config.version must be a finite number');
  }
  if (typeof parsed.config.values !== 'object' || parsed.config.values === null) {
    throw new Error('server config.config.values must be an object');
  }
  if (!Array.isArray(parsed.config.experiments)) {
    throw new Error('server config.config.experiments must be an array');
  }
  return parsed;
}
