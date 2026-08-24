import { assignmentHash, hashToUnitInterval, subjectHash } from './hash.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const canonical = {};
    for (const key of Object.keys(value).sort()) canonical[key] = canonicalize(value[key]);
    return canonical;
  }
  return value;
}

export function experimentFingerprint(experiment) {
  return subjectHash('wardx.experiment.snapshot', JSON.stringify(canonicalize(experiment)));
}

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
    this.stateMaxSubjects = options.stateMaxSubjects;
    this.stateBySubject = new Map();
    this.activeFingerprints = new Map();
  }

  hashSubject(subjectId) {
    return subjectHash(this.privacySalt, subjectId);
  }

  recordAssignment(subjectId, experiment, variant) {
    const subject = this.hashSubject(subjectId);
    let state = this.stateBySubject.get(subject);
    if (!state) {
      while (this.stateBySubject.size >= this.stateMaxSubjects) {
        const oldest = this.stateBySubject.keys().next().value;
        this.stateBySubject.delete(oldest);
      }
      state = { assignments: new Map() };
      this.stateBySubject.set(subject, state);
    }
    if (state.assignments.has(experiment.id)) return state.assignments.get(experiment.id);
    const assignment = {
      experiment: experiment.id,
      variant: variant.key,
      goalMetric: experiment.goalMetric,
      fingerprint: experimentFingerprint(experiment),
      exposed: false
    };
    state.assignments.set(experiment.id, assignment);
    return assignment;
  }

  assignmentsFor(subjectId) {
    const state = this.stateBySubject.get(this.hashSubject(subjectId));
    return state ? Array.from(state.assignments.values()) : [];
  }

  resolve(key, remoteValue, subjectId, experimentsByKey) {
    if (subjectId === undefined || subjectId === null) return remoteValue;
    const list = experimentsByKey.get(key);
    if (!list) return remoteValue;
    for (const experiment of list) {
      const variant = assignVariant(experiment, subjectId);
      if (!variant) continue;
      if (!Object.prototype.hasOwnProperty.call(variant.values, key)) continue;
      const assignment = this.recordAssignment(subjectId, experiment, variant);
      this._expose(assignment, subjectId);
      return variant.values[key];
    }
    return remoteValue;
  }

  _expose(assignment, subjectId) {
    if (assignment.exposed) return;
    assignment.exposed = true;
    const hashed = this.hashSubject(subjectId);
    this.onExposure({
      experiment: assignment.experiment,
      variant: assignment.variant,
      subject: hashed
    });
  }

  exposedAssignmentForGoal(subjectId, goalMetric) {
    const matches = this.assignmentsFor(subjectId).filter(
      (assignment) => assignment.exposed && assignment.goalMetric === goalMetric
    );
    if (matches.length > 1) {
      throw new Error(`goal metric ${goalMetric} matches multiple exposed experiments`);
    }
    return matches[0] || null;
  }

  applySnapshot(experiments) {
    const active = new Map();
    for (const experiment of experiments) {
      if (experiment.enabled) active.set(experiment.id, experimentFingerprint(experiment));
    }
    this.activeFingerprints = active;
    for (const [subject, state] of this.stateBySubject) {
      for (const [experimentId, assignment] of state.assignments) {
        if (active.get(experimentId) !== assignment.fingerprint) {
          state.assignments.delete(experimentId);
        }
      }
      if (state.assignments.size === 0) this.stateBySubject.delete(subject);
    }
  }
}
