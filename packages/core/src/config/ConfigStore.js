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
    const experiments = Array.isArray(snapshot.experiments) ? snapshot.experiments : [];
    for (const experiment of experiments) {
      if (typeof experiment.goalMetric !== 'string' || experiment.goalMetric.length === 0) {
        throw new Error(`experiment ${experiment.id} requires a non-empty goalMetric`);
      }
    }
    this.version = snapshot.version;
    this.values = snapshot.values && typeof snapshot.values === 'object' ? snapshot.values : Object.create(null);
    this.experiments = experiments;
    this.experimentsByKey = indexExperimentsByKey(this.experiments);
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.values, key);
  }

  getRaw(key) {
    return this.values[key];
  }
}
