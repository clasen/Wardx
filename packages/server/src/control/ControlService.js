import {
  annotateSignal,
  annotateWindows,
  assertSignalCategory,
  attachHypothesis,
  buildOnboarding,
  ensureRoleEntry,
  namesInCategory,
  presentRole,
  signalCategories,
  validateCatalog,
  validateSignalEntry
} from './catalog.js';
import { ConfigRepository } from '../config/ConfigRepository.js';
import { decideExperiment } from './experimentDecision.js';
import { assertRole, assertRoles } from '../roles.js';
import { assertExperimentKeysExist, toClientExperiment, validateExperiment } from './validateExperiment.js';
import { MutationConflictError, MutationJournal } from './MutationJournal.js';
import { applyControlStateChange, diffControlState } from './ControlStateChange.js';
import { SqliteMutationRepository } from '../storage/SqliteMutationRepository.js';

function materialize(normalized) {
  const catalog = structuredClone(normalized.catalog);
  catalog.persistLogs = Object.keys(catalog.persistLogsByName).sort();
  delete catalog.persistLogsByName;
  return {
    snapshot: {
      values: structuredClone(normalized.values),
      keyRoles: structuredClone(normalized.keyRoles),
      experiments: Object.values(normalized.experimentsById).map((experiment) => structuredClone(experiment))
    },
    catalog
  };
}

function mutationOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('mutation options are required');
  }
  return options;
}

function assertScalarAttrs(attrs) {
  if (attrs === undefined || attrs === null) return;
  if (typeof attrs !== 'object' || Array.isArray(attrs)) throw new Error('attrs must be an object');
  for (const [key, value] of Object.entries(attrs)) {
    if (key.length === 0) throw new Error('attrs keys must be non-empty strings');
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`attrs.${key} must be a string, number, or boolean`);
    }
  }
}

const HEALTH_FIELDS = [
  'duplicateExposures',
  'duplicateGoals',
  'conflictingGoals',
  'variantConflicts',
  'untrustedRows',
  'lateRows',
  'missingExposures',
  'implicitExposures'
];

function aggregateEvidence(rows, trustedOnly) {
  const byVariant = new Map();
  for (const row of rows) {
    if (trustedOnly && row.trustClass !== 'trusted') continue;
    let total = byVariant.get(row.key);
    if (!total) {
      total = { key: row.key, exposures: 0, goals: 0, goalSum: 0, goalSumSq: 0 };
      byVariant.set(row.key, total);
    }
    total.exposures += row.exposures;
    total.goals += row.goals;
    total.goalSum += row.goalSum;
    total.goalSumSq += row.goalSumSq;
  }
  return [...byVariant.values()].map((row) => ({
    ...row,
    goalMean: row.goals > 0 ? row.goalSum / row.goals : 0,
    rate: row.exposures > 0 ? row.goals / row.exposures : 0
  }));
}

function evidenceHealth(rows) {
  const health = { droppedFrames: 0 };
  for (const field of HEALTH_FIELDS) health[field] = 0;
  for (const row of rows) {
    for (const field of HEALTH_FIELDS) health[field] += row[field];
  }
  return health;
}

export class ControlService {
  constructor({ config, registry, persistence, diagnostics, stateStore, experimentLedger }) {
    this.config = config;
    this.registry = registry;
    this.persistence = persistence;
    this.diagnostics = diagnostics;
    this.stateStore = stateStore;
    this.experimentLedger = experimentLedger;
    this.mutationRepository = new SqliteMutationRepository({
      store: stateStore,
      capacity: config.control.journalCapacity
    });
    this.mutationJournal = new MutationJournal({
      repository: this.mutationRepository,
      capacity: config.control.journalCapacity,
      applyChange: applyControlStateChange
    });
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

  setProjectDescription(project, description, options) {
    if (typeof description !== 'string') throw new Error('description must be a string');
    const store = this.requireStore(project);
    const result = this._commitCatalog(project, store, (catalog) => {
      catalog.description = description;
    }, options, 'set_project_description', ['description']);
    return { project, ...result };
  }

  setSignal(project, name, signal, options) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
      throw new Error('signal is required');
    }
    validateSignalEntry(signal, 'signal');
    const store = this.requireStore(project);
    const result = this._commitCatalog(project, store, (catalog) => {
      catalog.signals[name] = structuredClone(signal);
    }, options, 'set_signal', [name]);
    return { project, name, ...result };
  }

  deleteSignal(project, name, options) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    const store = this.requireStore(project);
    if (!Object.prototype.hasOwnProperty.call(store.catalog.signals, name)) {
      throw new Error(`unknown signal: ${name}`);
    }
    const result = this._commitCatalog(project, store, (catalog) => {
      delete catalog.signals[name];
    }, options, 'delete_signal', [name]);
    return { project, name, ...result };
  }

  setInspectEvent(project, name, options) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    const store = this.requireStore(project);
    const result = this._commitCatalog(project, store, (catalog) => {
      if (!catalog.inspectEvents.includes(name)) catalog.inspectEvents.push(name);
    }, options, 'set_inspect_event', [name]);
    return { project, name, ...result };
  }

  deleteInspectEvent(project, name, options) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    const store = this.requireStore(project);
    const index = store.catalog.inspectEvents.indexOf(name);
    if (index === -1) throw new Error(`unknown inspect event: ${name}`);
    const result = this._commitCatalog(project, store, (catalog) => {
      catalog.inspectEvents.splice(index, 1);
    }, options, 'delete_inspect_event', [name]);
    return { project, name, ...result };
  }

  setPersistLog(project, name, options) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    const store = this.requireStore(project);
    const result = this._commitCatalog(project, store, (catalog) => {
      if (!catalog.persistLogs.includes(name)) catalog.persistLogs.push(name);
    }, options, 'set_persist_log', [name]);
    return { project, name, ...result };
  }

  deletePersistLog(project, name, options) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('name is required');
    const store = this.requireStore(project);
    const index = store.catalog.persistLogs.indexOf(name);
    if (index === -1) throw new Error(`unknown persist log: ${name}`);
    const result = this._commitCatalog(project, store, (catalog) => {
      catalog.persistLogs.splice(index, 1);
    }, options, 'delete_persist_log', [name]);
    store.aggregator.forgetPersistLog(name);
    return { project, name, ...result };
  }

  setRoleDescription(project, role, description, options) {
    assertRole(role);
    if (typeof description !== 'string' || description.length === 0) {
      throw new Error('description is required');
    }
    const store = this.requireStore(project);
    const result = this._commitCatalog(project, store, (catalog) => {
      ensureRoleEntry(catalog, role).description = description;
    }, options, 'set_role_description', [role]);
    return { project, role, ...result };
  }

  setRoleSource(project, role, source, options) {
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
    const result = this._commitCatalog(project, store, (catalog) => {
      const entry = ensureRoleEntry(catalog, role);
      if (path !== undefined) entry.path = path;
      if (git !== undefined) entry.git = git;
    }, options, 'set_role_source', [role]);
    return { project, role, ...result };
  }

  setValue(project, key, value, roles, options) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('key is required');
    assertRoles(roles, 'roles');
    this.requireStore(project);
    return this._mutate(project, options, 'set_config_value', [key], (state) => {
      state.values[key] = structuredClone(value);
      state.keyRoles[key] = [...roles];
    });
  }

  deleteValue(project, key, options) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('key is required');
    this.requireStore(project);
    const current = this.mutationRepository.read(project).state;
    if (!Object.prototype.hasOwnProperty.call(current.values, key)) {
      throw new Error(`unknown config key: ${key}`);
    }
    return this._mutate(project, options, 'delete_config_value', [key], (state) => {
      delete state.values[key];
      delete state.keyRoles[key];
    });
  }

  listExperiments(project) {
    const store = this.requireStore(project);
    return store.configRepo.snapshot().experiments.map((experiment) =>
      attachHypothesis(store.catalog, experiment)
    );
  }

  upsertExperiment(project, experiment, options) {
    validateExperiment(experiment);
    const hypothesis = experiment.hypothesis;
    if (hypothesis !== undefined) {
      if (typeof hypothesis !== 'string' || hypothesis.length === 0) {
        throw new Error('experiment.hypothesis must be a non-empty string');
      }
    }
    const client = toClientExperiment(experiment);
    delete client.shippedVariant;
    this.requireStore(project);
    const current = this.mutationRepository.read(project).state;
    assertExperimentKeysExist(client, current.values, current.keyRoles);
    const existing = current.experimentsById[client.id];
    if (existing && this.experimentLedger.hasTrustedExposure(project, client.id)) {
      const mutable = new Set(['enabled', 'shippedVariant']);
      const before = Object.fromEntries(Object.entries(existing).filter(([key]) => !mutable.has(key)));
      const after = Object.fromEntries(Object.entries(client).filter(([key]) => !mutable.has(key)));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`experiment ${client.id} plan is immutable after the first trusted exposure`);
      }
    }
    return this._mutate(project, options, 'upsert_experiment', [client.id], (state) => {
      state.experimentsById[client.id] = client;
      if (hypothesis !== undefined) state.catalog.experiments[client.id] = { hypothesis };
    });
  }

  setExperimentEnabled(project, id, enabled, options) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('experiment id is required');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    this.requireStore(project);
    const current = this.mutationRepository.read(project).state;
    const experiment = current.experimentsById[id];
    if (!experiment) throw new Error(`unknown experiment: ${id}`);
    if (enabled && experiment.shippedVariant) {
      throw new Error(`experiment ${id} was shipped and cannot be re-enabled`);
    }
    if (
      enabled &&
      this.experimentLedger.hasAnyEvidence(project, id) &&
      !this.experimentLedger.hasAssignmentRows(project, id)
    ) {
      throw new Error(`experiment ${id} evidence retention expired; use a new experiment id`);
    }
    const result = this._mutate(project, options, 'set_experiment_enabled', [id], (state) => {
      state.experimentsById[id].enabled = enabled;
    });
    if (enabled) this.experimentLedger.clearExpiry(project, id);
    else this.experimentLedger.scheduleExpiry(project, id, Date.now() + experiment.terminalRetentionMs);
    return result;
  }

  replaceSnapshot(project, snapshot, options) {
    this.requireStore(project);
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
    return this._mutate(project, options, 'replace_snapshot', ['*'], (state) => {
      state.values = structuredClone(snapshot.values);
      state.keyRoles = structuredClone(snapshot.keyRoles);
      state.experimentsById = Object.fromEntries(
        snapshot.experiments.map((experiment) => [experiment.id, toClientExperiment(experiment)])
      );
    });
  }

  aggregates(project, filter = {}) {
    const store = this.requireStore(project);
    if (filter.role !== undefined && filter.role !== null) assertRole(filter.role);
    const names = namesInCategory(store.catalog, filter.category, filter.names);
    const aggregateFilter = { ...filter };
    delete aggregateFilter.category;
    return annotateWindows(store.aggregator.snapshot({ ...aggregateFilter, names }), store.catalog);
  }

  experimentStats(project, experimentId) {
    if (typeof experimentId !== 'string' || experimentId.length === 0) {
      throw new Error('experiment id is required');
    }
    const store = this.requireStore(project);
    const definition = store.configRepo.experiments.find((row) => row.id === experimentId) || null;
    const provenance = this.experimentLedger.totals(project, experimentId);
    const variants = aggregateEvidence(provenance, true);
    const telemetryVariants = aggregateEvidence(provenance, false);
    const health = evidenceHealth(provenance);
    const persistedDecision = this.experimentLedger.readTerminalDecision(project, experimentId);
    let decision;
    if (persistedDecision) {
      if (definition) {
        this.experimentLedger.persistTerminalDecisionAndScheduleExpiry(
          project,
          experimentId,
          persistedDecision,
          persistedDecision.terminalInput.analysisAt + definition.terminalRetentionMs
        );
      }
      decision = definition?.shippedVariant
        ? { ...persistedDecision, status: 'shipped', shippedVariant: definition.shippedVariant }
        : persistedDecision;
    } else if (variants.every((row) => row.exposures === 0 && row.goals === 0)) {
      decision = {
        status: 'cannot_decide',
        next: definition?.outcomeKind ? 'collect' : 'configure',
        reason: 'no trusted eligible experiment evidence',
        leadingVariant: null,
        comparisons: []
      };
    } else {
      decision = decideExperiment(definition, variants, { analysisAt: Date.now(), health });
      if (decision.status !== 'collecting' && decision.terminalInput) {
        decision = this.experimentLedger.persistTerminalDecisionAndScheduleExpiry(
          project,
          experimentId,
          decision,
          decision.terminalInput.analysisAt + definition.terminalRetentionMs
        );
      }
    }
    const result = {
      experiment: definition ? attachHypothesis(store.catalog, definition) : null,
      variants,
      telemetryVariants,
      evidence: { eligibleTrustClass: 'trusted', provenance, health },
      decision
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

  shipExperiment(project, experimentId, variant, options) {
    if (typeof experimentId !== 'string' || experimentId.length === 0) {
      throw new Error('experiment id is required');
    }
    if (variant !== undefined && variant !== null) {
      if (typeof variant !== 'string' || variant.length === 0) {
        throw new Error('variant must be a non-empty string');
      }
    }
    const analysis = this.experimentStats(project, experimentId);
    if (!analysis.experiment) throw new Error(`unknown experiment: ${experimentId}`);
    const decision = this.experimentLedger.readTerminalDecision(project, experimentId);
    if (!decision || decision.status !== 'winner' || decision.evidenceHealth?.healthy !== true) {
      throw new Error(`experiment ${experimentId} is not ready to ship: persisted healthy terminal winner required`);
    }
    let key = variant === undefined || variant === null ? undefined : variant;
    if (key === undefined) {
      key = decision.leadingVariant;
    } else if (key !== decision.leadingVariant) {
      throw new Error(`experiment ${experimentId} is not ready to ship: ${decision.reason}`);
    }
    const chosen = analysis.experiment.variants.find((row) => row.key === key);
    if (!chosen) throw new Error(`unknown variant: ${key}`);
    const store = this.requireStore(project);
    const current = store.configRepo.snapshot();
    const currentExperiment = current.experiments.find((row) => row.id === experimentId);
    if (currentExperiment?.enabled === false && currentExperiment.shippedVariant === key) {
      mutationOptions(options);
      return { version: current.version, shippedVariant: key };
    }
    const result = this._mutate(project, options, 'ship_experiment', [experimentId, ...Object.keys(chosen.values)], (state) => {
      for (const [name, value] of Object.entries(chosen.values)) state.values[name] = structuredClone(value);
      state.experimentsById[experimentId].enabled = false;
      state.experimentsById[experimentId].shippedVariant = key;
    });
    this.experimentLedger.scheduleExpiry(project, experimentId, Date.now() + analysis.experiment.terminalRetentionMs);
    return { ...result, shippedVariant: key };
  }

  recentClients(project) {
    return this.requireStore(project).clients.list();
  }

  recentEvents(project, filter = {}) {
    const store = this.requireStore(project);
    const name = filter.name;
    if (name !== undefined && name !== null && (typeof name !== 'string' || name.length === 0)) {
      throw new Error('name must be a non-empty string');
    }
    const role = filter.role;
    if (role !== undefined && role !== null) assertRole(role);
    const attrs = filter.attrs;
    assertScalarAttrs(attrs);
    const limit = filter.limit;
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('limit must be an integer >= 1');
    }
    return store.events.query({ name, role, attrs, limit }).map((row) => ({
      ...row,
      ...annotateSignal(store.catalog, row.name)
    }));
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
    assertScalarAttrs(attrs);
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

  getOverview(project, limit, category) {
    const store = this.requireStore(project);
    const snapshot = store.configRepo.snapshot();
    const catalog = store.catalog;
    assertSignalCategory(category);
    const allKnobs = Object.keys(snapshot.values)
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
    const histogramRows = store.aggregator.topHistograms().map((row) => {
      const peak = {
        kind: 'histogram',
        name: row.name,
        dims: row.dims,
        role: row.role,
        count: row.count,
        sum: row.sum,
        min: row.min,
        max: row.max,
        ...annotateSignal(catalog, row.name)
      };
      if (row.exemplar) peak.exemplar = row.exemplar;
      return peak;
    });
    const logRows = store.aggregator.topPersistLogs().map((row) => ({
      kind: 'log',
      ...row,
      ...annotateSignal(catalog, row.name)
    }));
    const outcomes = [...counterRows, ...eventRows, ...histogramRows, ...logRows];
    const matchesCategory = (row) => category === undefined || category === null || row.category === category;
    const knobs = allKnobs.filter(matchesCategory);
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
      const counters = counterRows.filter((row) => row.role === name && matchesCategory(row));
      const events = eventRows.filter((row) => row.role === name && matchesCategory(row));
      const histograms = histogramRows.filter((row) => row.role === name && matchesCategory(row));
      const logs = logRows.filter((row) => row.role === name && matchesCategory(row));
      roles[name] = {
        ...presentRole(catalog.roles[name]),
        outcomes: [
          ...(limit === undefined || limit === null ? counters : counters.slice(0, limit)),
          ...(limit === undefined || limit === null ? events : events.slice(0, limit)),
          ...(limit === undefined || limit === null ? histograms : histograms.slice(0, limit)),
          ...(limit === undefined || limit === null ? logs : logs.slice(0, limit))
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
        knobs: allKnobs,
        outcomes,
        roleNames: names,
        catalogRoles: catalog.roles
      }),
      knobs,
      categories: signalCategories(catalog),
      inspectEvents: [...catalog.inspectEvents],
      persistLogs: [...catalog.persistLogs],
      roles,
      experiments: snapshot.experiments.map((experiment) => attachHypothesis(catalog, experiment)),
      history: {
        tiers: ['hour', 'day'],
        maxBuckets: this.config.history.maxQueryBuckets,
        maxRows: this.config.history.maxQueryRows
      }
    };
  }

  analyzeExperiment(project, experimentId) {
    return this.experimentStats(project, experimentId);
  }

  aggregateHistory(project, filter) {
    const store = this.requireStore(project);
    if (!filter || (filter.tier !== 'hour' && filter.tier !== 'day')) {
      throw new Error('history tier must be hour or day');
    }
    if (!Number.isInteger(filter.from) || !Number.isInteger(filter.to) || filter.to <= filter.from) {
      throw new Error('history from and to must be bounded integer timestamps with to > from');
    }
    if (filter.role !== undefined) assertRole(filter.role);
    if (filter.names !== undefined) {
      if (!Array.isArray(filter.names) || filter.names.some((name) => typeof name !== 'string' || name.length === 0)) {
        throw new Error('history names must be an array of non-empty strings');
      }
    }
    const names = namesInCategory(store.catalog, filter.category, filter.names);
    const historyFilter = { ...filter };
    delete historyFilter.category;
    const buckets = this.stateStore.queryHistory({
      project,
      ...historyFilter,
      names,
      limit: this.config.history.maxQueryRows
    });
    for (const bucket of buckets) {
      bucket.rows = bucket.rows.map((row) => {
        const output = { ...row, ...annotateSignal(store.catalog, row.name) };
        if (output.kind === 'distinct') delete output.registers;
        return output;
      });
    }
    const sourceTier = filter.tier === 'hour' ? 'minute' : 'hour';
    return {
      project,
      tier: filter.tier,
      from: filter.from,
      to: filter.to,
      buckets,
      completeness: {
        dropCount: buckets.reduce((sum, bucket) => sum + bucket.dropCount, 0),
        newestCompactedSourceWatermark: this.stateStore.readWatermark(project, sourceTier, filter.tier),
        allFinalized: buckets.every((bucket) => bucket.finalized)
      }
    };
  }

  listConfigChanges(project, { after = 0, limit = 100 } = {}) {
    this.requireStore(project);
    if (!Number.isInteger(after) || after < 0) throw new Error('after must be an integer >= 0');
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.control.journalCapacity) {
      throw new Error(`limit must be an integer between 1 and ${this.config.control.journalCapacity}`);
    }
    const all = this.mutationJournal.list(project);
    return {
      currentVersion: all.currentVersion,
      oldestAvailableVersion: all.oldestAvailableVersion,
      changes: all.changes.slice(after, after + limit),
      next: after + limit < all.changes.length ? after + limit : null
    };
  }

  rollbackConfigChange(project, changeId, options) {
    const settings = mutationOptions(options);
    try {
      const result = this.mutationJournal.rollback({
        project,
        changeId,
        expectedVersion: settings.expectedVersion,
        reason: settings.reason,
        clientIdentity: settings.clientIdentity
      });
      this._publish(project);
      return result;
    } catch (error) {
      if (!(error instanceof MutationConflictError)) {
        this.diagnostics.report('control.persistence_failed', error, { project });
      }
      throw error;
    }
  }

  _commitCatalog(project, _store, mutate, options, operation, affectedNames) {
    return this._mutate(project, options, operation, affectedNames, (state) => {
      const catalog = materialize(state).catalog;
      mutate(catalog);
      state.catalog = structuredClone(catalog);
      state.catalog.persistLogsByName = Object.fromEntries(catalog.persistLogs.map((name) => [name, true]));
      delete state.catalog.persistLogs;
    });
  }

  _mutate(project, options, operation, affectedNames, mutate) {
    const settings = mutationOptions(options);
    const before = this.mutationRepository.read(project).state;
    const after = structuredClone(before);
    mutate(after);
    const candidate = materialize(after);
    new ConfigRepository({ version: settings.expectedVersion + 1, ...candidate.snapshot });
    validateCatalog(candidate.catalog, `server config.projects.${project}.catalog`);
    const snapshots = this.registry.names().map((name) =>
      name === project ? candidate.snapshot : this.requireStore(name).configRepo.snapshot()
    );
    const reservedExperimentRows = snapshots
      .flatMap((snapshot) => snapshot.experiments)
      .filter((experiment) => experiment.enabled && experiment.targetSampleSizePerVariant !== undefined)
      .reduce((total, experiment) => total + experiment.targetSampleSizePerVariant * experiment.variants.length, 0);
    if (reservedExperimentRows > this.config.experiments.ledgerMaxRows) {
      throw new Error(
        `enabled experiment plans reserve ${reservedExperimentRows} ledger rows, exceeding ${this.config.experiments.ledgerMaxRows}`
      );
    }
    const forward = diffControlState(before, after);
    const inverse = diffControlState(after, before);
    try {
      const result = this.mutationJournal.commit({
        project,
        expectedVersion: settings.expectedVersion,
        reason: settings.reason,
        operation,
        affectedNames,
        clientIdentity: settings.clientIdentity,
        forward,
        inverse
      });
      this._publish(project);
      return result;
    } catch (error) {
      if (!(error instanceof MutationConflictError)) {
        this.diagnostics.report('control.persistence_failed', error, { project });
      }
      throw error;
    }
  }

  _publish(project) {
    const current = this.mutationRepository.read(project);
    const { snapshot, catalog } = materialize(current.state);
    const store = this.requireStore(project);
    const removedInspectEvents = store.catalog.inspectEvents
      .filter((name) => !catalog.inspectEvents.includes(name));
    for (const name of removedInspectEvents) store.events.forget(name);
    store.configRepo = new ConfigRepository({ version: current.version, ...snapshot });
    store.catalog = catalog;
  }
}
