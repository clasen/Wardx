import { createHash } from 'node:crypto';

export const HLL_PRECISION = 9;
export const HLL_REGISTER_COUNT = 1 << HLL_PRECISION;
export const HLL_MAX_RANK = 64 - HLL_PRECISION + 1;

function assertRegisters(registers) {
  if (!(registers instanceof Uint8Array) || registers.length !== HLL_REGISTER_COUNT) {
    throw new Error(`HLL registers must contain exactly ${HLL_REGISTER_COUNT} bytes`);
  }
  for (const rank of registers) {
    if (rank > HLL_MAX_RANK) throw new Error(`HLL register rank must be <= ${HLL_MAX_RANK}`);
  }
}

function rankAfterIndex(digest) {
  let rank = 1;
  for (let bit = HLL_PRECISION; bit < 64; bit++) {
    if ((digest[bit >> 3] & (1 << (7 - (bit & 7)))) !== 0) return rank;
    rank += 1;
  }
  return rank;
}

export function encodeHllRegisters(registers) {
  assertRegisters(registers);
  return Buffer.from(registers).toString('base64');
}

export function decodeHllRegisters(body) {
  if (!body || body.precision !== HLL_PRECISION || typeof body.registers !== 'string') {
    throw new Error(`HLL sketch must use precision ${HLL_PRECISION}`);
  }
  const decoded = Buffer.from(body.registers, 'base64');
  if (decoded.toString('base64') !== body.registers) throw new Error('HLL registers must be canonical base64');
  const registers = Uint8Array.from(decoded);
  assertRegisters(registers);
  return registers;
}

export function estimateHllRegisters(registers) {
  assertRegisters(registers);
  let harmonic = 0;
  let zeros = 0;
  for (const rank of registers) {
    harmonic += 2 ** -rank;
    if (rank === 0) zeros += 1;
  }
  const m = HLL_REGISTER_COUNT;
  const alpha = 0.7213 / (1 + 1.079 / m);
  const raw = alpha * m * m / harmonic;
  const corrected = raw <= 2.5 * m && zeros > 0 ? m * Math.log(m / zeros) : raw;
  return Math.round(corrected);
}

export function estimateHyperLogLog(body) {
  return estimateHllRegisters(decodeHllRegisters(body));
}

export function mergeHyperLogLog(left, right) {
  const leftRegisters = decodeHllRegisters(left);
  const rightRegisters = decodeHllRegisters(right);
  for (let index = 0; index < leftRegisters.length; index++) {
    if (rightRegisters[index] > leftRegisters[index]) leftRegisters[index] = rightRegisters[index];
  }
  return { precision: HLL_PRECISION, registers: encodeHllRegisters(leftRegisters) };
}

export class HyperLogLog {
  constructor(name, dims, privacySalt) {
    if (typeof privacySalt !== 'string' || privacySalt.length === 0) {
      throw new Error('distinct requires a non-empty privacySalt');
    }
    this.name = name;
    this.dims = dims;
    this.privacySalt = privacySalt;
    this.registers = new Uint8Array(HLL_REGISTER_COUNT);
    this.dirty = false;
  }

  add(identifier) {
    if (typeof identifier !== 'string' || identifier.length === 0) {
      throw new Error('distinct.add requires a non-empty string');
    }
    const digest = createHash('sha256')
      .update(this.privacySalt, 'utf8')
      .update('\0', 'utf8')
      .update(identifier, 'utf8')
      .digest();
    const index = (digest[0] << 1) | (digest[1] >> 7);
    const rank = rankAfterIndex(digest);
    if (rank > this.registers[index]) this.registers[index] = rank;
    this.dirty = true;
  }

  snapshot() {
    return { precision: HLL_PRECISION, registers: encodeHllRegisters(this.registers) };
  }

  reset() {
    this.registers.fill(0);
    this.dirty = false;
  }
}

export const NOOP_DISTINCT = Object.freeze({ add() {} });
