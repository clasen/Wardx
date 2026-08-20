import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CREATE_KEYS, REQUIRED_SDK_DEFAULT_KEYS } from './protocol.js';

const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'defaults.json');

export function requireKeys(object, keys, label) {
  const missing = [];
  for (const key of keys) {
    if (object[key] === undefined || object[key] === null) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`${label} missing required keys: ${missing.join(', ')}`);
  }
}

export function loadSdkDefaults() {
  let raw;
  try {
    raw = readFileSync(DEFAULTS_PATH, 'utf8');
  } catch {
    throw new Error(`Wardx SDK defaults file is missing at ${DEFAULTS_PATH}`);
  }
  const parsed = JSON.parse(raw);
  requireKeys(parsed, REQUIRED_SDK_DEFAULT_KEYS, 'SDK defaults');
  if (!Array.isArray(parsed.histogramBuckets) || parsed.histogramBuckets.length === 0) {
    throw new Error('SDK defaults histogramBuckets must be a non-empty array');
  }
  return parsed;
}

function assertPositiveNumber(settings, key) {
  const value = settings[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a finite number > 0`);
  }
}

function assertNumberInRange(settings, key, min, max) {
  const value = settings[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a finite number in [${min}, ${max}]`);
  }
}

export function resolveSettings(options) {
  if (options === null || typeof options !== 'object') {
    throw new Error('createWardx requires an options object');
  }
  requireKeys(options, REQUIRED_CREATE_KEYS, 'createWardx');
  const defaults = loadSdkDefaults();
  const settings = { ...defaults, ...options };
  if (settings.privacySalt === undefined || settings.privacySalt === null || settings.privacySalt === '') {
    settings.privacySalt = settings.projectKey;
  }
  assertPositiveNumber(settings, 'aggregateIntervalMs');
  assertPositiveNumber(settings, 'syncIntervalMs');
  assertPositiveNumber(settings, 'maxBufferedEvents');
  assertPositiveNumber(settings, 'maxBufferedLogs');
  assertPositiveNumber(settings, 'maxFrameBytes');
  assertPositiveNumber(settings, 'maxSeriesPerMetric');
  assertPositiveNumber(settings, 'maxDimensionKeys');
  assertPositiveNumber(settings, 'maxDimensionValueLength');
  assertPositiveNumber(settings, 'httpTimeoutMs');
  assertNumberInRange(settings, 'syncJitterMin', 0, 1);
  assertNumberInRange(settings, 'syncJitterMax', 1, 2);
  if (settings.syncJitterMin > settings.syncJitterMax) {
    throw new Error('syncJitterMin must be <= syncJitterMax');
  }
  if (!Array.isArray(settings.histogramBuckets) || settings.histogramBuckets.length === 0) {
    throw new Error('histogramBuckets must be a non-empty array');
  }
  let prev = -Infinity;
  for (const bound of settings.histogramBuckets) {
    if (typeof bound !== 'number' || !Number.isFinite(bound) || bound <= prev) {
      throw new Error('histogramBuckets must be strictly increasing finite numbers');
    }
    prev = bound;
  }
  return settings;
}

export function nextSyncDelayMs(settings) {
  const span = settings.syncJitterMax - settings.syncJitterMin;
  const factor = settings.syncJitterMin + Math.random() * span;
  return settings.syncIntervalMs * factor;
}
