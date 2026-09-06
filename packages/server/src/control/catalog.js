import { assertRole } from '../roles.js';
import { validateConfigConstraint } from './configConstraints.js';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const ROLE_ENTRY_KEYS = new Set(['description', 'path', 'git']);
const SIGNAL_ENTRY_KEYS = new Set(['description', 'category', 'constraint']);

function validateNameList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const name = value[index];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    if (seen.has(name)) throw new Error(`${label} duplicate name: ${name}`);
    seen.add(name);
  }
}

export function emptyCatalog() {
  return { description: '', roles: {}, signals: {}, experiments: {}, inspectEvents: [], persistLogs: [] };
}

export function normalizeRoleEntry(row) {
  const out = { description: typeof row.description === 'string' ? row.description : '' };
  if (typeof row.path === 'string' && row.path.length > 0) out.path = row.path;
  if (typeof row.git === 'string' && row.git.length > 0) out.git = row.git;
  return out;
}

export function normalizeSignalEntry(row) {
  const out = { description: typeof row.description === 'string' ? row.description : '' };
  if (typeof row.category === 'string' && row.category.length > 0) out.category = row.category;
  if (row.constraint !== undefined) out.constraint = structuredClone(row.constraint);
  return out;
}

export function presentRole(entry) {
  return normalizeRoleEntry(entry || {});
}

export function roleHasDescription(entry) {
  return Boolean(entry && typeof entry.description === 'string' && entry.description.trim().length > 0);
}

export function ensureRoleEntry(catalog, role) {
  if (!catalog.roles[role]) catalog.roles[role] = { description: '' };
  return catalog.roles[role];
}

export function validateRoleEntry(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(row)) {
    if (!ROLE_ENTRY_KEYS.has(key)) throw new Error(`${label} unknown key: ${key}`);
  }
  if (row.description !== undefined && typeof row.description !== 'string') {
    throw new Error(`${label}.description must be a string`);
  }
  if (row.path !== undefined) {
    if (typeof row.path !== 'string' || row.path.length === 0) {
      throw new Error(`${label}.path must be a non-empty string`);
    }
  }
  if (row.git !== undefined) {
    if (typeof row.git !== 'string' || row.git.length === 0) {
      throw new Error(`${label}.git must be a non-empty string`);
    }
  }
}

export function validateSignalEntry(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(row)) {
    if (!SIGNAL_ENTRY_KEYS.has(key)) throw new Error(`${label} unknown key: ${key}`);
  }
  if (typeof row.description !== 'string' || row.description.length === 0) {
    throw new Error(`${label}.description must be a non-empty string`);
  }
  if (row.category !== undefined && (typeof row.category !== 'string' || row.category.length === 0)) {
    throw new Error(`${label}.category must be a non-empty string`);
  }
  if (row.constraint !== undefined) validateConfigConstraint(row.constraint, `${label}.constraint`);
}

export function normalizeCatalog(catalog) {
  if (catalog === undefined || catalog === null) return emptyCatalog();
  validateCatalog(catalog, 'catalog');
  const experiments = {};
  if (catalog.experiments && typeof catalog.experiments === 'object') {
    for (const [id, row] of Object.entries(catalog.experiments)) {
      experiments[id] = { hypothesis: row.hypothesis };
    }
  }
  const roles = {};
  if (catalog.roles && typeof catalog.roles === 'object') {
    for (const [name, row] of Object.entries(catalog.roles)) {
      roles[name] = normalizeRoleEntry(row);
    }
  }
  const signals = {};
  if (catalog.signals && typeof catalog.signals === 'object') {
    for (const [name, row] of Object.entries(catalog.signals)) {
      signals[name] = normalizeSignalEntry(row);
    }
  }
  return {
    description: typeof catalog.description === 'string' ? catalog.description : '',
    roles,
    signals,
    experiments,
    inspectEvents: Array.isArray(catalog.inspectEvents) ? [...catalog.inspectEvents] : [],
    persistLogs: Array.isArray(catalog.persistLogs) ? [...catalog.persistLogs] : []
  };
}

export function validateCatalog(catalog, label) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(catalog)) {
    if (
      key !== 'description' &&
      key !== 'roles' &&
      key !== 'signals' &&
      key !== 'experiments' &&
      key !== 'inspectEvents' &&
      key !== 'persistLogs'
    ) {
      throw new Error(`${label} unknown key: ${key}`);
    }
  }
  if (catalog.description !== undefined && typeof catalog.description !== 'string') {
    throw new Error(`${label}.description must be a string`);
  }
  if (catalog.roles !== undefined) {
    if (typeof catalog.roles !== 'object' || catalog.roles === null || Array.isArray(catalog.roles)) {
      throw new Error(`${label}.roles must be an object`);
    }
    for (const [name, row] of Object.entries(catalog.roles)) {
      assertRole(name, `${label}.roles key`);
      validateRoleEntry(row, `${label}.roles.${name}`);
    }
  }
  if (catalog.signals !== undefined) {
    if (typeof catalog.signals !== 'object' || catalog.signals === null || Array.isArray(catalog.signals)) {
      throw new Error(`${label}.signals must be an object`);
    }
    for (const [name, row] of Object.entries(catalog.signals)) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`${label}.signals keys must be non-empty strings`);
      }
      validateSignalEntry(row, `${label}.signals.${name}`);
    }
  }
  if (catalog.inspectEvents !== undefined) validateNameList(catalog.inspectEvents, `${label}.inspectEvents`);
  if (catalog.persistLogs !== undefined) validateNameList(catalog.persistLogs, `${label}.persistLogs`);
  if (catalog.experiments !== undefined) {
    if (
      typeof catalog.experiments !== 'object' ||
      catalog.experiments === null ||
      Array.isArray(catalog.experiments)
    ) {
      throw new Error(`${label}.experiments must be an object`);
    }
    for (const [id, row] of Object.entries(catalog.experiments)) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`${label}.experiments keys must be non-empty strings`);
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${label}.experiments.${id} must be an object`);
      }
      if (typeof row.hypothesis !== 'string' || row.hypothesis.length === 0) {
        throw new Error(`${label}.experiments.${id}.hypothesis must be a non-empty string`);
      }
    }
  }
}

export function annotateSignal(catalog, name) {
  const row = catalog.signals[name];
  if (row && typeof row.description === 'string' && row.description.length > 0) return { ...row };
  return { undescribed: true };
}

export function signalCategories(catalog) {
  const categories = new Set();
  for (const row of Object.values(catalog.signals)) {
    if (typeof row.category === 'string' && row.category.length > 0) categories.add(row.category);
  }
  return [...categories].sort();
}

export function assertSignalCategory(category) {
  if (category === undefined || category === null) return;
  if (typeof category !== 'string' || category.length === 0) {
    throw new Error('category must be a non-empty string');
  }
}

export function namesInCategory(catalog, category, names) {
  assertSignalCategory(category);
  if (category === undefined || category === null) return names;
  if (names !== undefined && !Array.isArray(names)) throw new Error('names must be an array of strings');
  const candidates = names === undefined ? Object.keys(catalog.signals) : names;
  return candidates.filter((name) => catalog.signals[name]?.category === category);
}

export function isProtocolSignal(name) {
  return (
    typeof name === 'string' &&
    (name.startsWith('wardx.internal.') || name === 'experiment.exposure' || name === 'experiment.goal')
  );
}

export function buildOnboarding({ description, knobs, outcomes, roleNames, catalogRoles }) {
  const missingDescription = typeof description !== 'string' || description.trim().length === 0;
  const undescribedKnobs = [];
  for (const row of knobs) {
    if (row.undescribed && !isProtocolSignal(row.key)) undescribedKnobs.push(row.key);
  }
  const seen = new Set();
  const undescribedOutcomes = [];
  for (const row of outcomes) {
    if (!row.undescribed || isProtocolSignal(row.name) || seen.has(row.name)) continue;
    seen.add(row.name);
    undescribedOutcomes.push(row.name);
  }
  const undescribedRoles = [];
  for (const name of roleNames) {
    const entry = catalogRoles && catalogRoles[name];
    if (!roleHasDescription(entry)) undescribedRoles.push(name);
  }
  return {
    complete:
      !missingDescription &&
      undescribedKnobs.length === 0 &&
      undescribedOutcomes.length === 0 &&
      undescribedRoles.length === 0,
    missingDescription,
    undescribedKnobs,
    undescribedOutcomes,
    undescribedRoles
  };
}

export function attachHypothesis(catalog, experiment) {
  const out = cloneJson(experiment);
  const row = catalog.experiments[experiment.id];
  if (row && typeof row.hypothesis === 'string' && row.hypothesis.length > 0) {
    out.hypothesis = row.hypothesis;
  }
  return out;
}

export function annotateWindows(windows, catalog) {
  return windows.map((window) => ({
    ...window,
    counters: window.counters.map((row) => ({ ...row, ...annotateSignal(catalog, row.name) })),
    gauges: window.gauges.map((row) => ({ ...row, ...annotateSignal(catalog, row.name) })),
    histograms: window.histograms.map((row) => ({ ...row, ...annotateSignal(catalog, row.name) })),
    distincts: (window.distincts || []).map((row) => ({ ...row, ...annotateSignal(catalog, row.name) })),
    eventNames: window.eventNames.map((row) => ({ ...row, ...annotateSignal(catalog, row.name) })),
    logNames: window.logNames.map((row) => ({ ...row, ...annotateSignal(catalog, row.name) }))
  }));
}
