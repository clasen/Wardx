import { gzipSync } from 'node:zlib';
import {
  assertUnambiguousGoalMetrics,
  toClientExperiment,
  toWireExperiment,
  validateExperiment
} from '../control/validateExperiment.js';
import { experimentsForRole, validateKeyRoles, valuesForRole } from '../roles.js';
import { validateConfigConstraints } from '../control/configConstraints.js';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
    for (const experiment of snapshot.experiments) validateExperiment(experiment);
    assertUnambiguousGoalMetrics(snapshot.experiments);
    validateConfigConstraints(snapshot, snapshot.catalog);
    this.version = snapshot.version;
    this.values = cloneJson(snapshot.values);
    this.keyRoles = cloneJson(snapshot.keyRoles);
    this.experiments = snapshot.experiments.map((experiment) => toClientExperiment(experiment));
    this.configJson = JSON.stringify({
      values: this.values,
      experiments: this.experiments
    });
    this.configGzip = gzipSync(Buffer.from(this.configJson));
    this.wireByRole = new Map();
  }

  _wireJson(role) {
    let json = this.wireByRole.get(role);
    if (json !== undefined) return json;
    json = JSON.stringify({
      values: valuesForRole(this.values, this.keyRoles, role),
      experiments: experimentsForRole(this.experiments, role).map(toWireExperiment)
    });
    this.wireByRole.set(role, json);
    return json;
  }

  snapshot() {
    return {
      version: this.version,
      values: cloneJson(this.values),
      keyRoles: cloneJson(this.keyRoles),
      experiments: cloneJson(this.experiments)
    };
  }

  buildResponse(includeConfig, role) {
    const serverTime = Date.now();
    if (includeConfig) {
      return `{"ok":true,"serverTime":${serverTime},"configVersion":${this.version},"config":${this._wireJson(role)}}`;
    }
    return `{"ok":true,"serverTime":${serverTime},"configVersion":${this.version}}`;
  }
}
