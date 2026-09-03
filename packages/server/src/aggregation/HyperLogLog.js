const PRECISION = 9;
const REGISTER_COUNT = 1 << PRECISION;
const MAX_RANK = 64 - PRECISION + 1;

export function decodeHllBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('HLL sketch must be an object');
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'precision' && key !== 'registers')) {
    throw new Error('HLL sketch contains an unknown key');
  }
  if (body.precision !== PRECISION) throw new Error(`HLL precision must be ${PRECISION}`);
  if (typeof body.registers !== 'string') throw new Error('HLL registers must be canonical base64');
  const registers = Buffer.from(body.registers, 'base64');
  if (registers.toString('base64') !== body.registers) {
    throw new Error('HLL registers must be canonical base64');
  }
  if (registers.length !== REGISTER_COUNT) {
    throw new Error(`HLL registers must contain exactly ${REGISTER_COUNT} bytes`);
  }
  for (const rank of registers) {
    if (rank > MAX_RANK) throw new Error(`HLL register rank must be <= ${MAX_RANK}`);
  }
  return registers;
}

export function normalizeHllBody(body) {
  const registers = decodeHllBody(body);
  return { precision: PRECISION, registers: registers.toString('base64') };
}

export function mergeHllBodies(left, right) {
  const merged = decodeHllBody(left);
  const incoming = decodeHllBody(right);
  for (let index = 0; index < merged.length; index++) {
    if (incoming[index] > merged[index]) merged[index] = incoming[index];
  }
  return { precision: PRECISION, registers: merged.toString('base64') };
}

export function estimateHllBody(body) {
  const registers = decodeHllBody(body);
  let harmonic = 0;
  let zeros = 0;
  for (const rank of registers) {
    harmonic += 2 ** -rank;
    if (rank === 0) zeros += 1;
  }
  const alpha = 0.7213 / (1 + 1.079 / REGISTER_COUNT);
  const raw = alpha * REGISTER_COUNT * REGISTER_COUNT / harmonic;
  const corrected = raw <= 2.5 * REGISTER_COUNT && zeros > 0
    ? REGISTER_COUNT * Math.log(REGISTER_COUNT / zeros)
    : raw;
  return Math.round(corrected);
}
