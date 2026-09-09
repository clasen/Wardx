import { gzipSync } from 'node:zlib';
import xxhash from 'xxhash-wasm';
import { resolveConfigRules, validateConfigRules } from './rules.js';
import {
  assertUnambiguousGoalMetrics,
  toClientExperiment,
  toWireExperiment,
  validateExperiment
} from '../control/validateExperiment.js';
import { experimentsForRole, validateKeyRoles, valuesForRole } from '../roles.js';
import { validateConfigConstraints } from '../control/configConstraints.js';

const { h64ToString } = await xxhash();

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function wireSnapshot(values, experimentsJson) {
  const wire = `{"values":${JSON.stringify(values)},"experiments":${experimentsJson}}`;
  return { wire, context: h64ToString(wire) };
}

export class ConfigRepository {
  constructor(initial) {
    this.replace(initial);
  }

  replace(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('config snapshot must be an object');
    }
    if (typeof snapshot.version !== 'number' || !Number.isFinite(snapshot.version)) {
      throw new Error('config version must be a finite number');
    }
    if (!snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)) {
      throw new Error('config values must be an object');
    }
    if (!Array.isArray(snapshot.experiments)) {
      throw new Error('config experiments must be an array');
    }
    validateKeyRoles(snapshot.values, snapshot.keyRoles, 'config snapshot');
    validateConfigRules(snapshot.values, snapshot.keyRules);
    for (const experiment of snapshot.experiments) validateExperiment(experiment);
    assertUnambiguousGoalMetrics(snapshot.experiments);
    validateConfigConstraints(snapshot, snapshot.catalog);
    this.version = snapshot.version;
    this.values = cloneJson(snapshot.values);
    this.keyRoles = cloneJson(snapshot.keyRoles);
    this.keyRules = cloneJson(snapshot.keyRules ?? {});
    this.experiments = snapshot.experiments.map((experiment) => toClientExperiment(experiment));
    this.configJson = JSON.stringify({
      values: this.values,
      experiments: this.experiments
    });
    this.configGzip = gzipSync(Buffer.from(this.configJson));
    this.roleViews = new Map();
  }

  _roleView(role) {
    let view = this.roleViews.get(role);
    if (view) return view;
    const values = valuesForRole(this.values, this.keyRoles, role);
    const keyRules = Object.fromEntries(Object.entries(this.keyRules)
      .filter(([key, rules]) => Object.hasOwn(values, key) && rules.length > 0));
    const conditionalValues = Object.fromEntries(Object.keys(keyRules).map((key) => [key, values[key]]));
    const experimentsJson = JSON.stringify(experimentsForRole(this.experiments, role).map(toWireExperiment));
    view = {
      values, keyRules, conditionalValues, experimentsJson,
      hasRules: Object.keys(keyRules).length > 0,
      base: wireSnapshot(values, experimentsJson)
    };
    this.roleViews.set(role, view);
    return view;
  }

  _wireSnapshot(client) {
    const view = this._roleView(client.role);
    if (!view.hasRules) return view.base;
    let values;
    for (const [key, value] of Object.entries(resolveConfigRules(view.conditionalValues, view.keyRules, client))) {
      if (value !== view.values[key]) {
        values ??= { ...view.values };
        values[key] = value;
      }
    }
    return values ? wireSnapshot(values, view.experimentsJson) : view.base;
  }

  snapshot() {
    return {
      version: this.version,
      values: cloneJson(this.values),
      keyRoles: cloneJson(this.keyRoles),
      keyRules: cloneJson(this.keyRules),
      experiments: cloneJson(this.experiments)
    };
  }

  buildResponse(configVersion, client, configContext) {
    const serverTime = Date.now();
    const { wire, context } = this._wireSnapshot(client);
    const config = configVersion !== this.version || configContext !== context ? `,"config":${wire}` : '';
    return `{"ok":true,"serverTime":${serverTime},"configVersion":${this.version},"configContext":"${context}"${config}}`;
  }
}
