import { annotateSignal, annotateWindows, attachHypothesis, buildOnboarding, ensureRoleEntry, presentRole } from './catalog.js';
import { persistServerConfig } from './persist.js';
import { assertRole, assertRoles } from '../roles.js';
import { assertExperimentKeysExist, toClientExperiment, validateExperiment } from './validateExperiment.js';

export class ControlService {
  constructor({ config, registry }) {
    this.config = config;
    this.registry = registry;
  }

  listProjects() {
    return this.registry.names();
  }

  requireStore(project) {
    if (typeof project !== 'string' || project.length === 0) {
      throw new Error('project is required');
    }
    const store = this.registry.get(project);
    if (!store) throw new Error(`unknown project: ${project}`);
    return store;
  }

  getConfig(project) {
    return this.requireStore(project).configRepo.snapshot();
  }

  getCatalog(project) {
    return this.requireStore(project).catalog;
  }

  setProjectDescription(project, description) {
    if (typeof description !== 'string') throw new Error('description must be a string');
    const store = this.requireStore(project);
    store.catalog.description = description;
    persistServerConfig(this.config, this.registry);
    return { project };
  }

  setSignal(project, name, description) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    if (typeof description !== 'string' || description.length === 0) {
      throw new Error('description is required');
    }
    const store = this.requireStore(project);
    store.catalog.signals[name] = description;
    persistServerConfig(this.config, this.registry);
    return { project, name };
  }

  deleteSignal(project, name) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    const store = this.requireStore(project);
    if (!Object.prototype.hasOwnProperty.call(store.catalog.signals, name)) {
      throw new Error(`unknown signal: ${name}`);
    }
    delete store.catalog.signals[name];
    persistServerConfig(this.config, this.registry);
    return { project, name };
  }

  setRoleDescription(project, role, description) {
    assertRole(role);
    if (typeof description !== 'string' || description.length === 0) {
      throw new Error('description is required');
    }
    const store = this.requireStore(project);
    ensureRoleEntry(store.catalog, role).description = description;
    persistServerConfig(this.config, this.registry);
    return { project, role };
  }

  setRoleSource(project, role, source) {
    assertRole(role);
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('source must be an object');
    }
    const path = source.path;
    const git = source.git;
    if (path !== undefined) {
      if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string');
    }
    if (git !== undefined) {
      if (typeof git !== 'string' || git.length === 0) throw new Error('git must be a non-empty string');
    }
    if (path === undefined && git === undefined) {
      throw new Error('path or git is required');
    }
    const store = this.requireStore(project);
    const entry = ensureRoleEntry(store.catalog, role);
    if (path !== undefined) entry.path = path;
    if (git !== undefined) entry.git = git;
    persistServerConfig(this.config, this.registry);
    return { project, role };
  }

  setValue(project, key, value, roles) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('key is required');
    assertRoles(roles, 'roles');
    const store = this.requireStore(project);
    const current = store.configRepo.snapshot();
    current.values[key] = value;
    current.keyRoles[key] = [...roles];
    this._commit(store, current);
    return { version: store.configRepo.version };
  }

  deleteValue(project, key) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('key is required');
    const store = this.requireStore(project);
    const current = store.configRepo.snapshot();
    if (!Object.prototype.hasOwnProperty.call(current.values, key)) {
      throw new Error(`unknown config key: ${key}`);
    }
    delete current.values[key];
    delete current.keyRoles[key];
    this._commit(store, current);
    return { version: store.configRepo.version };
  }

  listExperiments(project) {
    const store = this.requireStore(project);
    return store.configRepo.snapshot().experiments.map((experiment) =>
      attachHypothesis(store.catalog, experiment)
    );
  }

  upsertExperiment(project, experiment) {
    validateExperiment(experiment);
    const hypothesis = experiment.hypothesis;
    if (hypothesis !== undefined) {
      if (typeof hypothesis !== 'string' || hypothesis.length === 0) {
        throw new Error('experiment.hypothesis must be a non-empty string');
      }
    }
    const client = toClientExperiment(experiment);
    const store = this.requireStore(project);
    const current = store.configRepo.snapshot();
    assertExperimentKeysExist(client, current.values, current.keyRoles);
    const index = current.experiments.findIndex((row) => row.id === client.id);
    if (index === -1) current.experiments.push(client);
    else current.experiments[index] = client;
    if (hypothesis !== undefined) {
      store.catalog.experiments[client.id] = { hypothesis };
    }
    this._commit(store, current);
    return { version: store.configRepo.version };
  }

  setExperimentEnabled(project, id, enabled) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('experiment id is required');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const store = this.requireStore(project);
    const current = store.configRepo.snapshot();
    const experiment = current.experiments.find((row) => row.id === id);
    if (!experiment) throw new Error(`unknown experiment: ${id}`);
    experiment.enabled = enabled;
    this._commit(store, current);
    return { version: store.configRepo.version };
  }

  replaceSnapshot(project, snapshot) {
    const store = this.requireStore(project);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('config snapshot must be an object');
    }
    if (!snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)) {
      throw new Error('config values must be an object');
    }
    if (!Array.isArray(snapshot.experiments)) {
      throw new Error('config experiments must be an array');
    }
    for (const experiment of snapshot.experiments) {
      validateExperiment(experiment);
      assertExperimentKeysExist(experiment, snapshot.values, snapshot.keyRoles);
    }
    this._commit(store, {
      values: snapshot.values,
      keyRoles: snapshot.keyRoles,
      experiments: snapshot.experiments.map((experiment) => toClientExperiment(experiment))
    });
    return { version: store.configRepo.version };
  }

  aggregates(project, filter = {}) {
    const store = this.requireStore(project);
    if (filter.role !== undefined && filter.role !== null) assertRole(filter.role);
    return annotateWindows(store.aggregator.snapshot(filter), store.catalog);
  }

  experimentStats(project, experimentId) {
    if (typeof experimentId !== 'string' || experimentId.length === 0) {
      throw new Error('experiment id is required');
    }
    const store = this.requireStore(project);
    const definition = store.configRepo.experiments.find((row) => row.id === experimentId) || null;
    const variants = store.aggregator.experimentStats(experimentId);
    const result = {
      experiment: definition ? attachHypothesis(store.catalog, definition) : null,
      variants
    };
    if (definition && definition.primaryMetric) {
      result.primaryMetric = {
        name: definition.primaryMetric,
        total: store.aggregator.counterTotal(definition.primaryMetric),
        ...annotateSignal(store.catalog, definition.primaryMetric)
      };
    }
    return result;
  }

  recentClients(project) {
    return this.requireStore(project).clients.list();
  }

  recentLogs(project, filter = {}) {
    const store = this.requireStore(project);
    const level = filter.level;
    const message = filter.message;
    const attrs = filter.attrs;
    const limit = filter.limit;
    if (level !== undefined && level !== null) {
      if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') {
        throw new Error('level must be debug, info, warn, or error');
      }
    }
    if (message !== undefined && message !== null) {
      if (typeof message !== 'string' || message.length === 0) {
        throw new Error('message must be a non-empty string');
      }
    }
    if (attrs !== undefined && attrs !== null) {
      if (typeof attrs !== 'object' || Array.isArray(attrs)) {
        throw new Error('attrs must be an object');
      }
      for (const [key, value] of Object.entries(attrs)) {
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error('attrs keys must be non-empty strings');
        }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(`attrs.${key} must be a string, number, or boolean`);
        }
      }
    }
    if (limit !== undefined && limit !== null) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be an integer >= 1');
    }
    const role = filter.role;
    if (role !== undefined && role !== null) assertRole(role);
    return store.logs.query({ level, message, attrs, limit, role }).map((row) => ({
      ...row,
      ...annotateSignal(store.catalog, row.message)
    }));
  }

  getOverview(project, limit) {
    const store = this.requireStore(project);
    const snapshot = store.configRepo.snapshot();
    const catalog = store.catalog;
    const knobs = Object.keys(snapshot.values)
      .sort()
      .map((key) => ({
        key,
        value: snapshot.values[key],
        roles: [...snapshot.keyRoles[key]],
        ...annotateSignal(catalog, key)
      }));
    const counterRows = store.aggregator.topCounters().map((row) => ({
      kind: 'counter',
      name: row.name,
      dims: row.dims,
      value: row.value,
      role: row.role,
      ...annotateSignal(catalog, row.name)
    }));
    const eventRows = store.aggregator.topEventNames().map((row) => ({
      kind: 'event',
      name: row.name,
      count: row.count,
      role: row.role,
      ...annotateSignal(catalog, row.name)
    }));
    const outcomes = [...counterRows, ...eventRows];
    const clients = store.clients.list();
    const roleNames = new Set();
    for (const targets of Object.values(snapshot.keyRoles)) {
      for (const name of targets) {
        if (name !== '*') roleNames.add(name);
      }
    }
    for (const name of Object.keys(catalog.roles)) roleNames.add(name);
    for (const row of clients) roleNames.add(row.role);
    for (const row of outcomes) roleNames.add(row.role);
    const names = [...roleNames].sort();
    const roles = {};
    for (const name of names) {
      const counters = counterRows.filter((row) => row.role === name);
      const events = eventRows.filter((row) => row.role === name);
      roles[name] = {
        ...presentRole(catalog.roles[name]),
        outcomes: [
          ...(limit === undefined || limit === null ? counters : counters.slice(0, limit)),
          ...(limit === undefined || limit === null ? events : events.slice(0, limit))
        ],
        clients: clients.filter((row) => row.role === name)
      };
    }
    return {
      project,
      version: snapshot.version,
      description: catalog.description,
      onboarding: buildOnboarding({
        description: catalog.description,
        knobs,
        outcomes,
        roleNames: names,
        catalogRoles: catalog.roles
      }),
      knobs,
      roles,
      experiments: snapshot.experiments.map((experiment) => attachHypothesis(catalog, experiment))
    };
  }

  analyzeExperiment(project, experimentId) {
    return this.experimentStats(project, experimentId);
  }

  _commit(store, snapshot) {
    store.configRepo.replace({
      version: store.configRepo.version + 1,
      values: snapshot.values,
      keyRoles: snapshot.keyRoles,
      experiments: snapshot.experiments
    });
    persistServerConfig(this.config, this.registry);
  }
}
