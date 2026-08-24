import { createHash } from 'node:crypto';

const encoder = new TextEncoder();

export const FNV_OFFSET_32 = 0x811c9dc5;
export const FNV_PRIME_32 = 0x01000193;
export const UINT32 = 4294967296;

export function fnv1a32(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let hash = FNV_OFFSET_32;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash;
}

export function hashToUnitInterval(hash) {
  return hash / UINT32;
}

export function assignmentHash(experimentId, subjectId, salt) {
  return fnv1a32(`${experimentId}:${subjectId}:${salt}`);
}

export function subjectHash(projectSalt, subjectId) {
  return createHash('sha256')
    .update(projectSalt, 'utf8')
    .update('\0', 'utf8')
    .update(subjectId, 'utf8')
    .digest('hex');
}
