function normalize(stored) {
  const catalog = structuredClone(stored.catalog);
  catalog.inspectEvents = Array.isArray(catalog.inspectEvents) ? [...catalog.inspectEvents] : [];
  catalog.persistLogsByName = Object.fromEntries(catalog.persistLogs.map((name) => [name, true]));
  delete catalog.persistLogs;
  return {
    values: stored.state.values,
    keyRoles: stored.state.keyRoles,
    keyRules: stored.state.keyRules ?? {},
    experimentsById: Object.fromEntries(stored.state.experiments.map((experiment) => [experiment.id, experiment])),
    catalog
  };
}

function denormalize(state) {
  const catalog = structuredClone(state.catalog);
  catalog.persistLogs = Object.keys(catalog.persistLogsByName).sort();
  delete catalog.persistLogsByName;
  return {
    state: {
      values: state.values,
      keyRoles: state.keyRoles,
      keyRules: state.keyRules,
      experiments: Object.values(state.experimentsById)
    },
    catalog
  };
}

export class SqliteMutationRepository {
  constructor({ store, capacity }) {
    if (!store || typeof store.readProjectState !== 'function') throw new Error('SQLite state store is required');
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('mutation capacity must be an integer >= 1');
    this.store = store;
    this.capacity = capacity;
  }

  read(project) {
    const stored = this.store.readProjectState(project);
    if (!stored) throw new Error(`unknown project: ${project}`);
    const changes = this.store.database
      .prepare('SELECT entry_json FROM mutation_journal WHERE project = ? ORDER BY id DESC LIMIT ?')
      .all(project, this.capacity)
      .reverse()
      .map((row) => JSON.parse(row.entry_json));
    return { version: stored.version, state: normalize(stored), changes };
  }

  transact(project, work) {
    const current = this.read(project);
    const output = work(structuredClone(current));
    if (!output || !output.next || !output.result) throw new Error('mutation transaction must return next and result');
    const appended = output.next.changes.at(-1);
    const { state, catalog } = denormalize(output.next.state);
    this.store.commitProjectMutation({
      project,
      previousVersion: current.version,
      newVersion: output.next.version,
      state,
      catalog,
      entry: appended,
      journalCapacity: this.capacity,
      createdAt: appended.timestamp
    });
    return output.result;
  }
}
