import { assignmentHash, hashToUnitInterval, subjectHash } from './hash.js';

export function assignVariant(experiment, subjectId) {
  if (!experiment.enabled) return null;
  const hash = assignmentHash(experiment.id, subjectId, experiment.salt);
  const bucket = hashToUnitInterval(hash);
  if (bucket >= experiment.allocation) return null;
  const variants = experiment.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error(`experiment ${experiment.id} has no variants`);
  }
  let totalWeight = 0;
  for (let i = 0; i < variants.length; i++) {
    const weight = variants[i].weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`experiment ${experiment.id} has invalid variant weight`);
    }
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    throw new Error(`experiment ${experiment.id} variant weights must sum to > 0`);
  }
  let threshold = 0;
  for (let i = 0; i < variants.length; i++) {
    threshold += (variants[i].weight / totalWeight) * experiment.allocation;
    if (bucket < threshold) return variants[i];
  }
  return variants[variants.length - 1];
}

export function indexExperimentsByKey(experiments) {
  const map = new Map();
  if (!Array.isArray(experiments)) return map;
  for (const experiment of experiments) {
    if (!experiment.enabled) continue;
    for (const variant of experiment.variants) {
      for (const key of Object.keys(variant.values)) {
        let list = map.get(key);
        if (!list) {
          list = [];
          map.set(key, list);
        }
        if (!list.includes(experiment)) list.push(experiment);
      }
    }
  }
  return map;
}

export class ExperimentResolver {
  constructor(options) {
    this.privacySalt = options.privacySalt;
    this.onExposure = options.onExposure;
    this.exposureKeys = new Set();
    this.assignmentsBySubject = new Map();
  }

  hashSubject(subjectId) {
    return subjectHash(this.privacySalt, subjectId);
  }

  recordAssignment(subjectId, experiment, variant) {
    let list = this.assignmentsBySubject.get(subjectId);
    if (!list) {
      list = [];
      this.assignmentsBySubject.set(subjectId, list);
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].experiment === experiment.id) return;
    }
    list.push({ experiment: experiment.id, variant: variant.key });
  }

  assignmentsFor(subjectId) {
    return this.assignmentsBySubject.get(subjectId) || [];
  }

  resolve(key, remoteValue, subjectId, experimentsByKey) {
    if (subjectId === undefined || subjectId === null) return remoteValue;
    const list = experimentsByKey.get(key);
    if (!list) return remoteValue;
    for (const experiment of list) {
      const variant = assignVariant(experiment, subjectId);
      if (!variant) continue;
      if (!Object.prototype.hasOwnProperty.call(variant.values, key)) continue;
      this.recordAssignment(subjectId, experiment, variant);
      this._expose(experiment, variant, subjectId);
      return variant.values[key];
    }
    return remoteValue;
  }

  _expose(experiment, variant, subjectId) {
    const hashed = this.hashSubject(subjectId);
    const exposureKey = experiment.id + '\0' + hashed;
    if (this.exposureKeys.has(exposureKey)) return;
    this.exposureKeys.add(exposureKey);
    this.onExposure({
      experiment: experiment.id,
      variant: variant.key,
      subject: hashed
    });
  }

  relevantExperiments(subjectId, experiments) {
    const known = this.assignmentsFor(subjectId);
    if (known.length > 0) return known;
    const attached = [];
    if (!Array.isArray(experiments)) return attached;
    for (const experiment of experiments) {
      if (!experiment.enabled) continue;
      const variant = assignVariant(experiment, subjectId);
      if (!variant) continue;
      attached.push({ experiment: experiment.id, variant: variant.key });
    }
    return attached;
  }
}
