import xxhash from 'xxhash-wasm';

const { h64 } = await xxhash();

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

export function subjectHash64(projectSalt, subjectId) {
  return h64(`${projectSalt}\0${subjectId}`);
}

export function subjectHash(projectSalt, subjectId) {
  return subjectHash64(projectSalt, subjectId).toString(16).padStart(16, '0');
}
