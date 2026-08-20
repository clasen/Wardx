import { indexExperimentsByKey } from './ExperimentResolver.js';

export class ConfigStore {
  constructor() {
    this.version = 0;
    this.values = Object.create(null);
    this.experiments = [];
    this.experimentsByKey = new Map();
  }

  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('config snapshot must be an object');
    }
    if (typeof snapshot.version !== 'number' || !Number.isFinite(snapshot.version)) {
      throw new Error('config snapshot version must be a finite number');
    }
    this.version = snapshot.version;
    this.values = snapshot.values && typeof snapshot.values === 'object' ? snapshot.values : Object.create(null);
    this.experiments = Array.isArray(snapshot.experiments) ? snapshot.experiments : [];
    this.experimentsByKey = indexExperimentsByKey(this.experiments);
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.values, key);
  }

  getRaw(key) {
    return this.values[key];
  }
}
