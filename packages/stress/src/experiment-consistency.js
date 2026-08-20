import { assignVariant } from '@wardx/core';
import { report } from './measure.js';

function fnv1a32Independent(input) {
  const bytes = Buffer.from(input, 'utf8');
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function assignIndependent(experiment, subjectId) {
  const hash = fnv1a32Independent(`${experiment.id}:${subjectId}:${experiment.salt}`);
  const bucket = hash / 4294967296;
  if (bucket >= experiment.allocation) return null;
  let totalWeight = 0;
  for (const variant of experiment.variants) totalWeight += variant.weight;
  let threshold = 0;
  for (const variant of experiment.variants) {
    threshold += (variant.weight / totalWeight) * experiment.allocation;
    if (bucket < threshold) return variant;
  }
  return experiment.variants[experiment.variants.length - 1];
}

export function testG({ subjects = 1_000_000 } = {}) {
  const experiment = {
    id: 'message-delay-v1',
    enabled: true,
    allocation: 1,
    salt: '3ad8f9',
    variants: [
      { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
      { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
    ]
  };
  const counts = { control: 0, fast: 0 };
  let mismatches = 0;
  let unstable = 0;
  for (let i = 0; i < subjects; i++) {
    const subjectId = `user-${i}`;
    const a = assignVariant(experiment, subjectId);
    const b = assignIndependent(experiment, subjectId);
    const again = assignVariant(experiment, subjectId);
    if (a.key !== b.key) mismatches += 1;
    if (a.key !== again.key) unstable += 1;
    counts[a.key] += 1;
  }
  const controlRatio = counts.control / subjects;
  const partial = { ...experiment, allocation: 0.2 };
  let allocated = 0;
  for (let i = 0; i < 100_000; i++) {
    if (assignVariant(partial, `alloc-${i}`)) allocated += 1;
  }
  const allocRatio = allocated / 100_000;
  const weighted = {
    ...experiment,
    variants: [
      { key: 'control', weight: 10, values: {} },
      { key: 'fast', weight: 90, values: {} }
    ]
  };
  const weightedCounts = { control: 0, fast: 0 };
  for (let i = 0; i < 100_000; i++) {
    weightedCounts[assignVariant(weighted, `w-${i}`).key] += 1;
  }
  report('G experiment consistency', {
    subjects,
    control: counts.control,
    fast: counts.fast,
    'control ratio': controlRatio.toFixed(4),
    'independent mismatches': mismatches,
    'unstable assignments': unstable,
    'allocation 0.2 ratio': allocRatio.toFixed(4),
    'weighted 10/90 fast ratio': (weightedCounts.fast / 100_000).toFixed(4)
  });
  if (mismatches !== 0) throw new Error('independent hash implementations diverged');
  if (unstable !== 0) throw new Error('assignment was not stable');
  if (controlRatio < 0.48 || controlRatio > 0.52) {
    throw new Error(`50/50 split out of range: ${controlRatio}`);
  }
  if (allocRatio < 0.18 || allocRatio > 0.22) {
    throw new Error(`allocation 0.2 out of range: ${allocRatio}`);
  }
  if (weightedCounts.fast / 100_000 < 0.88 || weightedCounts.fast / 100_000 > 0.92) {
    throw new Error('weighted 10/90 split out of range');
  }
  return { counts, mismatches, allocRatio };
}
