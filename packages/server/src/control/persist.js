import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normalizeHllBody } from '../aggregation/HyperLogLog.js';

const STAT_KEYS = ['exposures', 'goals', 'goalSum', 'goalSumSq'];

function writeJsonAtomic(path, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function fileShape(config, registry, override) {
  const projects = {};
  for (const name of registry.names()) {
    const store = registry.get(name);
    projects[name] = {
      ...(override && override.project === name ? override.snapshot : store.configRepo.snapshot()),
      catalog: override && override.project === name ? override.catalog : store.catalog
    };
  }
  const out = {
    host: config.host,
    port: config.port,
    credentials: config.credentials,
    sink: config.sink,
    maxRequestBytes: config.maxRequestBytes,
    maxClockSkewMs: config.maxClockSkewMs,
    maxFramesPerEnvelope: config.maxFramesPerEnvelope,
    maxItemsPerEnvelope: config.maxItemsPerEnvelope,
    maxNameBytes: config.maxNameBytes,
    maxDimensionKeys: config.maxDimensionKeys,
    maxDimensionValueLength: config.maxDimensionValueLength,
    maxAttributeKeys: config.maxAttributeKeys,
    maxAttributeValueLength: config.maxAttributeValueLength,
    persistenceFlushIntervalMs: config.persistenceFlushIntervalMs,
    diagnostics: config.diagnostics,
    aggregateRetentionMinutes: config.aggregateRetentionMinutes,
    aggregateMaxSeriesPerMetric: config.aggregateMaxSeriesPerMetric,
    memorySinkMaxEnvelopes: config.memorySinkMaxEnvelopes,
    recentClientsMax: config.recentClientsMax,
    recentLogsMax: config.recentLogsMax,
    sqlite: config.sqlite,
    history: config.history,
    control: config.control,
    capacity: config.capacity,
    experiments: config.experiments,
    projects
  };
  if (typeof config.ndjsonPath === 'string' && config.ndjsonPath.length > 0) {
    out.ndjsonPath = config.ndjsonPath;
  }
  return out;
}

export function persistServerConfig(config, registry, override) {
  const path = config.configPath;
  if (!path) return;
  writeJsonAtomic(path, fileShape(config, registry, override));
}

export function experimentStatsPath(configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    throw new Error('config path is required');
  }
  return `${configPath}.experiment-stats.json`;
}

function assertIntegerCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be an integer >= 0`);
  }
}

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

export function validateExperimentStats(snapshot, label = 'experiment stats') {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(snapshot)) {
    if (key !== 'projects') throw new Error(`${label} unknown key: ${key}`);
  }
  if (snapshot.projects === undefined) throw new Error(`${label}.projects is required`);
  if (!snapshot.projects || typeof snapshot.projects !== 'object' || Array.isArray(snapshot.projects)) {
    throw new Error(`${label}.projects must be an object`);
  }
  for (const [name, experiments] of Object.entries(snapshot.projects)) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${label}.projects keys must be non-empty strings`);
    }
    if (!experiments || typeof experiments !== 'object' || Array.isArray(experiments)) {
      throw new Error(`${label}.projects.${name} must be an object`);
    }
    for (const [id, variants] of Object.entries(experiments)) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`${label}.projects.${name} keys must be non-empty strings`);
      }
      if (!variants || typeof variants !== 'object' || Array.isArray(variants)) {
        throw new Error(`${label}.projects.${name}.${id} must be an object`);
      }
      for (const [key, stats] of Object.entries(variants)) {
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error(`${label}.projects.${name}.${id} keys must be non-empty strings`);
        }
        if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
          throw new Error(`${label}.projects.${name}.${id}.${key} must be an object`);
        }
        for (const field of Object.keys(stats)) {
          if (!STAT_KEYS.includes(field)) {
            throw new Error(`${label}.projects.${name}.${id}.${key} unknown key: ${field}`);
          }
        }
        for (const field of STAT_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(stats, field)) {
            throw new Error(`${label}.projects.${name}.${id}.${key}.${field} is required`);
          }
        }
        assertIntegerCount(stats.exposures, `${label}.projects.${name}.${id}.${key}.exposures`);
        assertIntegerCount(stats.goals, `${label}.projects.${name}.${id}.${key}.goals`);
        assertFiniteNumber(stats.goalSum, `${label}.projects.${name}.${id}.${key}.goalSum`);
        assertFiniteNumber(stats.goalSumSq, `${label}.projects.${name}.${id}.${key}.goalSumSq`);
      }
    }
  }
}

function emptyStats() {
  return { projects: {} };
}

function isEmptyStats(snapshot) {
  for (const experiments of Object.values(snapshot.projects)) {
    if (Object.keys(experiments).length > 0) return false;
  }
  return true;
}

export function snapshotExperimentStats(registry) {
  const projects = {};
  for (const name of registry.names()) {
    projects[name] = registry.get(name).aggregator.lifetimeSnapshot();
  }
  return { projects };
}

export function loadExperimentStats(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyStats();
    throw err;
  }
  const parsed = JSON.parse(raw);
  validateExperimentStats(parsed);
  return parsed;
}

export function hydrateExperimentStats(config, registry) {
  if (!config.configPath) return;
  const snapshot = loadExperimentStats(experimentStatsPath(config.configPath));
  for (const name of registry.names()) {
    const experiments = snapshot.projects[name];
    if (experiments) registry.get(name).aggregator.replaceLifetime(experiments);
  }
}

export function persistExperimentStats(config, registry) {
  const path = config.configPath;
  if (!path) return;
  const snapshot = snapshotExperimentStats(registry);
  const dest = experimentStatsPath(path);
  if (isEmptyStats(snapshot) && !existsSync(dest)) return;
  writeJsonAtomic(dest, snapshot);
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LOG_STAT_KEYS = new Set(['count', 'exemplar']);
const EXEMPLAR_KEYS = new Set(['ts', 'attrs', 'instanceId']);

export function logStatsPath(configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    throw new Error('config path is required');
  }
  return `${configPath}.log-stats.json`;
}

export function validateLogStats(snapshot, label = 'log stats') {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(snapshot)) {
    if (key !== 'projects') throw new Error(`${label} unknown key: ${key}`);
  }
  if (snapshot.projects === undefined) throw new Error(`${label}.projects is required`);
  if (!snapshot.projects || typeof snapshot.projects !== 'object' || Array.isArray(snapshot.projects)) {
    throw new Error(`${label}.projects must be an object`);
  }
  for (const [project, logs] of Object.entries(snapshot.projects)) {
    if (typeof project !== 'string' || project.length === 0) {
      throw new Error(`${label}.projects keys must be non-empty strings`);
    }
    if (!logs || typeof logs !== 'object' || Array.isArray(logs)) {
      throw new Error(`${label}.projects.${project} must be an object`);
    }
    for (const [name, byRole] of Object.entries(logs)) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`${label}.projects.${project} keys must be non-empty strings`);
      }
      if (!byRole || typeof byRole !== 'object' || Array.isArray(byRole)) {
        throw new Error(`${label}.projects.${project}.${name} must be an object`);
      }
      for (const [role, byLevel] of Object.entries(byRole)) {
        if (typeof role !== 'string' || role.length === 0) {
          throw new Error(`${label}.projects.${project}.${name} keys must be non-empty strings`);
        }
        if (!byLevel || typeof byLevel !== 'object' || Array.isArray(byLevel)) {
          throw new Error(`${label}.projects.${project}.${name}.${role} must be an object`);
        }
        for (const [level, stats] of Object.entries(byLevel)) {
          if (!LOG_LEVELS.has(level)) {
            throw new Error(`${label}.projects.${project}.${name}.${role} unknown level: ${level}`);
          }
          if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
            throw new Error(`${label}.projects.${project}.${name}.${role}.${level} must be an object`);
          }
          for (const field of Object.keys(stats)) {
            if (!LOG_STAT_KEYS.has(field)) {
              throw new Error(`${label}.projects.${project}.${name}.${role}.${level} unknown key: ${field}`);
            }
          }
          if (!Object.prototype.hasOwnProperty.call(stats, 'count')) {
            throw new Error(`${label}.projects.${project}.${name}.${role}.${level}.count is required`);
          }
          assertIntegerCount(stats.count, `${label}.projects.${project}.${name}.${role}.${level}.count`);
          if (stats.count < 1) {
            throw new Error(`${label}.projects.${project}.${name}.${role}.${level}.count must be an integer >= 1`);
          }
          if (stats.exemplar !== undefined && stats.exemplar !== null) {
            validateLogExemplar(stats.exemplar, `${label}.projects.${project}.${name}.${role}.${level}.exemplar`);
          }
        }
      }
    }
  }
}

function validateLogExemplar(exemplar, label) {
  if (!exemplar || typeof exemplar !== 'object' || Array.isArray(exemplar)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(exemplar)) {
    if (!EXEMPLAR_KEYS.has(key)) throw new Error(`${label} unknown key: ${key}`);
  }
  if (typeof exemplar.ts !== 'number' || !Number.isFinite(exemplar.ts)) {
    throw new Error(`${label}.ts must be a finite number`);
  }
  if (typeof exemplar.instanceId !== 'string' || exemplar.instanceId.length === 0) {
    throw new Error(`${label}.instanceId must be a non-empty string`);
  }
  if (exemplar.attrs !== undefined && exemplar.attrs !== null) {
    if (typeof exemplar.attrs !== 'object' || Array.isArray(exemplar.attrs)) {
      throw new Error(`${label}.attrs must be an object`);
    }
  }
}

function isEmptyLogStats(snapshot) {
  for (const logs of Object.values(snapshot.projects)) {
    if (Object.keys(logs).length > 0) return false;
  }
  return true;
}

export function snapshotLogStats(registry) {
  const projects = {};
  for (const name of registry.names()) {
    const store = registry.get(name);
    const allowed = new Set(store.catalog.persistLogs);
    const full = store.aggregator.persistLogSnapshot();
    const logs = {};
    for (const [message, byRole] of Object.entries(full)) {
      if (!allowed.has(message)) continue;
      logs[message] = byRole;
    }
    projects[name] = logs;
  }
  return { projects };
}

export function loadLogStats(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyStats();
    throw err;
  }
  const parsed = JSON.parse(raw);
  validateLogStats(parsed);
  return parsed;
}

export function hydrateLogStats(config, registry) {
  if (!config.configPath) return;
  const snapshot = loadLogStats(logStatsPath(config.configPath));
  for (const name of registry.names()) {
    const store = registry.get(name);
    const allowed = new Set(store.catalog.persistLogs);
    const incoming = snapshot.projects[name];
    if (!incoming) continue;
    const logs = {};
    for (const [message, byRole] of Object.entries(incoming)) {
      if (allowed.has(message)) logs[message] = byRole;
    }
    store.aggregator.replacePersistLogs(logs);
  }
}

export function persistLogStats(config, registry) {
  const path = config.configPath;
  if (!path) return;
  const snapshot = snapshotLogStats(registry);
  const dest = logStatsPath(path);
  if (isEmptyLogStats(snapshot) && !existsSync(dest)) return;
  writeJsonAtomic(dest, snapshot);
}

const WINDOW_KEYS = [
  'from',
  'to',
  'frames',
  'events',
  'logs',
  'cardinalityDropped',
  'roles',
  'counters',
  'gauges',
  'histograms',
  'distincts',
  'eventNames',
  'logNames',
  'experiments'
];
const ROLE_STAT_KEYS = ['frames', 'events', 'logs'];
const COUNTER_KEYS = ['name', 'dims', 'role', 'value'];
const GAUGE_KEYS = ['name', 'dims', 'role', 'value', 'timestamp'];
const HISTOGRAM_KEYS = ['name', 'dims', 'role', 'body'];
const HISTOGRAM_BODY_KEYS = new Set(['count', 'sum', 'min', 'max', 'buckets', 'exemplar']);
const DISTINCT_KEYS = ['name', 'dims', 'role', 'body'];
const EVENT_NAME_KEYS = ['name', 'role', 'count'];
const LOG_NAME_KEYS = new Set(['name', 'level', 'role', 'count', 'exemplar']);
const WINDOW_EXPERIMENT_KEYS = ['id', 'variants'];
const WINDOW_VARIANT_KEYS = ['key', 'exposures', 'goals', 'goalSum', 'goalSumSq'];
const HIST_EXEMPLAR_KEYS = new Set(['value', 'attrs']);

export function aggregateWindowsPath(configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    throw new Error('config path is required');
  }
  return `${configPath}.aggregate-windows.json`;
}

function assertKnownKeys(object, allowed, label) {
  const allow = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allow.has(key)) throw new Error(`${label} unknown key: ${key}`);
  }
}

function assertRequiredKeys(object, keys, label) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

function assertRoleName(role, label) {
  if (typeof role !== 'string' || role.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (role === '*') throw new Error(`${label} cannot be *`);
}

function assertDims(dims, label) {
  if (dims === null) return;
  if (!dims || typeof dims !== 'object' || Array.isArray(dims)) {
    throw new Error(`${label} must be an object or null`);
  }
  for (const [key, value] of Object.entries(dims)) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`${label} keys must be non-empty strings`);
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`${label}.${key} must be a string, number, or boolean`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be a finite number`);
    }
  }
}

function assertMetricName(name, label) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateHistogramBody(body, label) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} must be an object`);
  }
  assertKnownKeys(body, HISTOGRAM_BODY_KEYS, label);
  assertRequiredKeys(body, ['count', 'sum', 'min', 'max', 'buckets'], label);
  assertIntegerCount(body.count, `${label}.count`);
  assertFiniteNumber(body.sum, `${label}.sum`);
  assertFiniteNumber(body.min, `${label}.min`);
  assertFiniteNumber(body.max, `${label}.max`);
  if (!Array.isArray(body.buckets)) throw new Error(`${label}.buckets must be an array`);
  for (let i = 0; i < body.buckets.length; i++) {
    const pair = body.buckets[i];
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`${label}.buckets[${i}] must be [bound, count]`);
    }
    assertFiniteNumber(pair[0], `${label}.buckets[${i}].0`);
    assertIntegerCount(pair[1], `${label}.buckets[${i}].1`);
  }
  if (body.exemplar !== undefined && body.exemplar !== null) {
    const exemplar = body.exemplar;
    if (!exemplar || typeof exemplar !== 'object' || Array.isArray(exemplar)) {
      throw new Error(`${label}.exemplar must be an object`);
    }
    assertKnownKeys(exemplar, HIST_EXEMPLAR_KEYS, `${label}.exemplar`);
    if (typeof exemplar.value !== 'number' || !Number.isFinite(exemplar.value)) {
      throw new Error(`${label}.exemplar.value must be a finite number`);
    }
    if (exemplar.attrs !== undefined && exemplar.attrs !== null) {
      if (typeof exemplar.attrs !== 'object' || Array.isArray(exemplar.attrs)) {
        throw new Error(`${label}.exemplar.attrs must be an object`);
      }
    }
  }
}

function validateWindowRow(window, label) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) {
    throw new Error(`${label} must be an object`);
  }
  assertKnownKeys(window, WINDOW_KEYS, label);
  assertRequiredKeys(window, WINDOW_KEYS.filter((key) => key !== 'distincts'), label);
  if (typeof window.from !== 'number' || !Number.isFinite(window.from) || window.from % 60000 !== 0) {
    throw new Error(`${label}.from must be a minute-aligned timestamp`);
  }
  if (window.to !== window.from + 60000) {
    throw new Error(`${label}.to must be from + 60000`);
  }
  assertIntegerCount(window.frames, `${label}.frames`);
  assertIntegerCount(window.events, `${label}.events`);
  assertIntegerCount(window.logs, `${label}.logs`);
  assertIntegerCount(window.cardinalityDropped, `${label}.cardinalityDropped`);
  if (!window.roles || typeof window.roles !== 'object' || Array.isArray(window.roles)) {
    throw new Error(`${label}.roles must be an object`);
  }
  for (const [role, stats] of Object.entries(window.roles)) {
    assertRoleName(role, `${label}.roles key`);
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      throw new Error(`${label}.roles.${role} must be an object`);
    }
    assertKnownKeys(stats, ROLE_STAT_KEYS, `${label}.roles.${role}`);
    assertRequiredKeys(stats, ROLE_STAT_KEYS, `${label}.roles.${role}`);
    assertIntegerCount(stats.frames, `${label}.roles.${role}.frames`);
    assertIntegerCount(stats.events, `${label}.roles.${role}.events`);
    assertIntegerCount(stats.logs, `${label}.roles.${role}.logs`);
  }
  if (!Array.isArray(window.counters)) throw new Error(`${label}.counters must be an array`);
  for (let i = 0; i < window.counters.length; i++) {
    const row = window.counters[i];
    const rowLabel = `${label}.counters[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${rowLabel} must be an object`);
    assertKnownKeys(row, COUNTER_KEYS, rowLabel);
    assertRequiredKeys(row, COUNTER_KEYS, rowLabel);
    assertMetricName(row.name, `${rowLabel}.name`);
    assertDims(row.dims, `${rowLabel}.dims`);
    assertRoleName(row.role, `${rowLabel}.role`);
    assertFiniteNumber(row.value, `${rowLabel}.value`);
  }
  if (!Array.isArray(window.gauges)) throw new Error(`${label}.gauges must be an array`);
  for (let i = 0; i < window.gauges.length; i++) {
    const row = window.gauges[i];
    const rowLabel = `${label}.gauges[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${rowLabel} must be an object`);
    assertKnownKeys(row, GAUGE_KEYS, rowLabel);
    assertRequiredKeys(row, GAUGE_KEYS, rowLabel);
    assertMetricName(row.name, `${rowLabel}.name`);
    assertDims(row.dims, `${rowLabel}.dims`);
    assertRoleName(row.role, `${rowLabel}.role`);
    assertFiniteNumber(row.value, `${rowLabel}.value`);
    assertFiniteNumber(row.timestamp, `${rowLabel}.timestamp`);
  }
  if (!Array.isArray(window.histograms)) throw new Error(`${label}.histograms must be an array`);
  for (let i = 0; i < window.histograms.length; i++) {
    const row = window.histograms[i];
    const rowLabel = `${label}.histograms[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${rowLabel} must be an object`);
    assertKnownKeys(row, HISTOGRAM_KEYS, rowLabel);
    assertRequiredKeys(row, HISTOGRAM_KEYS, rowLabel);
    assertMetricName(row.name, `${rowLabel}.name`);
    assertDims(row.dims, `${rowLabel}.dims`);
    assertRoleName(row.role, `${rowLabel}.role`);
    validateHistogramBody(row.body, `${rowLabel}.body`);
  }
  const distincts = window.distincts || [];
  if (!Array.isArray(distincts)) throw new Error(`${label}.distincts must be an array`);
  for (let i = 0; i < distincts.length; i++) {
    const row = distincts[i];
    const rowLabel = `${label}.distincts[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${rowLabel} must be an object`);
    assertKnownKeys(row, DISTINCT_KEYS, rowLabel);
    assertRequiredKeys(row, DISTINCT_KEYS, rowLabel);
    assertMetricName(row.name, `${rowLabel}.name`);
    assertDims(row.dims, `${rowLabel}.dims`);
    assertRoleName(row.role, `${rowLabel}.role`);
    normalizeHllBody(row.body);
  }
  if (!Array.isArray(window.eventNames)) throw new Error(`${label}.eventNames must be an array`);
  for (let i = 0; i < window.eventNames.length; i++) {
    const row = window.eventNames[i];
    const rowLabel = `${label}.eventNames[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${rowLabel} must be an object`);
    assertKnownKeys(row, EVENT_NAME_KEYS, rowLabel);
    assertRequiredKeys(row, EVENT_NAME_KEYS, rowLabel);
    assertMetricName(row.name, `${rowLabel}.name`);
    assertRoleName(row.role, `${rowLabel}.role`);
    assertIntegerCount(row.count, `${rowLabel}.count`);
  }
  if (!Array.isArray(window.logNames)) throw new Error(`${label}.logNames must be an array`);
  for (let i = 0; i < window.logNames.length; i++) {
    const row = window.logNames[i];
    const rowLabel = `${label}.logNames[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${rowLabel} must be an object`);
    assertKnownKeys(row, LOG_NAME_KEYS, rowLabel);
    assertRequiredKeys(row, ['name', 'level', 'role', 'count'], rowLabel);
    assertMetricName(row.name, `${rowLabel}.name`);
    if (!LOG_LEVELS.has(row.level)) throw new Error(`${rowLabel}.level must be debug, info, warn, or error`);
    assertRoleName(row.role, `${rowLabel}.role`);
    assertIntegerCount(row.count, `${rowLabel}.count`);
    if (row.count < 1) throw new Error(`${rowLabel}.count must be an integer >= 1`);
    if (row.exemplar !== undefined && row.exemplar !== null) {
      validateLogExemplar(row.exemplar, `${rowLabel}.exemplar`);
    }
  }
  if (!Array.isArray(window.experiments)) throw new Error(`${label}.experiments must be an array`);
  for (let i = 0; i < window.experiments.length; i++) {
    const experiment = window.experiments[i];
    const expLabel = `${label}.experiments[${i}]`;
    if (!experiment || typeof experiment !== 'object' || Array.isArray(experiment)) {
      throw new Error(`${expLabel} must be an object`);
    }
    assertKnownKeys(experiment, WINDOW_EXPERIMENT_KEYS, expLabel);
    assertRequiredKeys(experiment, WINDOW_EXPERIMENT_KEYS, expLabel);
    if (typeof experiment.id !== 'string' || experiment.id.length === 0) {
      throw new Error(`${expLabel}.id must be a non-empty string`);
    }
    if (!Array.isArray(experiment.variants)) throw new Error(`${expLabel}.variants must be an array`);
    for (let j = 0; j < experiment.variants.length; j++) {
      const variant = experiment.variants[j];
      const varLabel = `${expLabel}.variants[${j}]`;
      if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
        throw new Error(`${varLabel} must be an object`);
      }
      assertKnownKeys(variant, WINDOW_VARIANT_KEYS, varLabel);
      assertRequiredKeys(variant, WINDOW_VARIANT_KEYS, varLabel);
      if (typeof variant.key !== 'string' || variant.key.length === 0) {
        throw new Error(`${varLabel}.key must be a non-empty string`);
      }
      assertIntegerCount(variant.exposures, `${varLabel}.exposures`);
      assertIntegerCount(variant.goals, `${varLabel}.goals`);
      assertFiniteNumber(variant.goalSum, `${varLabel}.goalSum`);
      assertFiniteNumber(variant.goalSumSq, `${varLabel}.goalSumSq`);
    }
  }
}

export function validateAggregateWindows(snapshot, label = 'aggregate windows') {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${label} must be an object`);
  }
  assertKnownKeys(snapshot, ['projects'], label);
  if (snapshot.projects === undefined) throw new Error(`${label}.projects is required`);
  if (!snapshot.projects || typeof snapshot.projects !== 'object' || Array.isArray(snapshot.projects)) {
    throw new Error(`${label}.projects must be an object`);
  }
  for (const [project, windows] of Object.entries(snapshot.projects)) {
    if (typeof project !== 'string' || project.length === 0) {
      throw new Error(`${label}.projects keys must be non-empty strings`);
    }
    if (!Array.isArray(windows)) throw new Error(`${label}.projects.${project} must be an array`);
    const seen = new Set();
    for (let i = 0; i < windows.length; i++) {
      validateWindowRow(windows[i], `${label}.projects.${project}[${i}]`);
      if (seen.has(windows[i].from)) {
        throw new Error(`${label}.projects.${project} duplicate window from: ${windows[i].from}`);
      }
      seen.add(windows[i].from);
    }
  }
}

function isEmptyAggregateWindows(snapshot) {
  for (const windows of Object.values(snapshot.projects)) {
    if (windows.length > 0) return false;
  }
  return true;
}

export function snapshotAggregateWindows(registry) {
  const projects = {};
  for (const name of registry.names()) {
    projects[name] = registry.get(name).aggregator.windowsSnapshot();
  }
  return { projects };
}

export function loadAggregateWindows(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { projects: {} };
    throw err;
  }
  const parsed = JSON.parse(raw);
  validateAggregateWindows(parsed);
  return parsed;
}

export function hydrateAggregateWindows(config, registry) {
  if (!config.configPath) return;
  const snapshot = loadAggregateWindows(aggregateWindowsPath(config.configPath));
  for (const name of registry.names()) {
    const windows = snapshot.projects[name];
    if (windows) registry.get(name).aggregator.replaceWindows(windows);
  }
}

export function persistAggregateWindows(config, registry) {
  const path = config.configPath;
  if (!path) return;
  const snapshot = snapshotAggregateWindows(registry);
  const dest = aggregateWindowsPath(path);
  if (isEmptyAggregateWindows(snapshot) && !existsSync(dest)) return;
  writeJsonAtomic(dest, snapshot);
}
