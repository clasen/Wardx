import { validateConfigSnapshot } from '../config/ConfigRepository.js';
import { validateCatalog } from './catalog.js';
import { validateConfigConstraints } from './configConstraints.js';

// Turns the normalized control state kept by the mutation journal into the
// config snapshot and catalog shapes served to clients and MCP callers.
export function materialize(normalized) {
  const catalog = structuredClone(normalized.catalog);
  catalog.persistLogs = Object.keys(catalog.persistLogsByName).sort();
  delete catalog.persistLogsByName;
  return {
    snapshot: {
      values: structuredClone(normalized.values),
      keyRoles: structuredClone(normalized.keyRoles),
      keyRules: structuredClone(normalized.keyRules),
      experiments: Object.values(normalized.experimentsById).map((experiment) => structuredClone(experiment))
    },
    catalog
  };
}

// The single definition of a valid project state: a self-consistent config
// snapshot, a valid catalog, and config values that honour catalog constraints.
export function validateProjectState({ snapshot, catalog }, { version, label = 'config snapshot', catalogLabel = `${label}.catalog` }) {
  validateConfigSnapshot({ version, ...snapshot });
  validateCatalog(catalog, catalogLabel);
  validateConfigConstraints(snapshot, catalog, label);
}
