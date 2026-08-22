import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const STAT_KEYS = ['exposures', 'goals', 'goalSum', 'goalSumSq'];

function writeJsonAtomic(path, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function fileShape(config, registry) {
  const projects = {};
  for (const name of registry.names()) {
    const store = registry.get(name);
    projects[name] = {
      ...store.configRepo.snapshot(),
      catalog: store.catalog
    };
  }
  const out = {
    host: config.host,
    port: config.port,
    projectKeys: config.projectKeys,
    sink: config.sink,
    maxRequestBytes: config.maxRequestBytes,
    aggregateRetentionMinutes: config.aggregateRetentionMinutes,
    aggregateMaxSeriesPerMetric: config.aggregateMaxSeriesPerMetric,
    memorySinkMaxEnvelopes: config.memorySinkMaxEnvelopes,
    recentClientsMax: config.recentClientsMax,
    recentLogsMax: config.recentLogsMax,
    projects
  };
  if (typeof config.ndjsonPath === 'string' && config.ndjsonPath.length > 0) {
    out.ndjsonPath = config.ndjsonPath;
  }
  return out;
}

export function persistServerConfig(config, registry) {
  const path = config.configPath;
  if (!path) return;
  writeJsonAtomic(path, fileShape(config, registry));
  persistExperimentStats(config, registry);
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
