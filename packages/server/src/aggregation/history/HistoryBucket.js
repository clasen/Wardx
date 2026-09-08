import { estimateHllBody, mergeHllBodies, normalizeHllBody } from '../HyperLogLog.js';

const TIERS = new Set(['minute', 'hour', 'day']);
const KINDS = new Set(['counter', 'event', 'log', 'gauge', 'histogram', 'distinct', 'drop']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const FORBIDDEN_KEYS = new Set([
  'attrs',
  'exemplar',
  'instanceid',
  'sessionid',
  'subject',
  'subjectid',
  'subjecthash',
  'assignmenthash'
]);

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function integerCount(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be an integer >= 0`);
  return value;
}

function dimensions(value, label) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object or null`);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    nonEmptyString(key, `${label} key`);
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`${label}.${key} is prohibited in history`);
    const item = value[key];
    if (typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) {
      throw new Error(`${label}.${key} must be a string, boolean, or finite number`);
    }
    out[key] = item;
  }
  return out;
}

function baseRow(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} must be an object`);
  if (!KINDS.has(row.kind)) throw new Error(`${label}.kind is invalid`);
  return {
    kind: row.kind,
    name: nonEmptyString(row.name, `${label}.name`),
    role: nonEmptyString(row.role, `${label}.role`),
    environment: nonEmptyString(row.environment, `${label}.environment`),
    appVersion: nonEmptyString(row.appVersion, `${label}.appVersion`),
    dimensions: dimensions(row.dimensions ?? null, `${label}.dimensions`)
  };
}

export function normalizeHistoricalRow(row, label = 'historical row') {
  const out = baseRow(row, label);
  if (row.kind === 'counter') {
    out.value = finiteNumber(row.value, `${label}.value`);
  } else if (row.kind === 'event' || row.kind === 'drop') {
    out.count = integerCount(row.count, `${label}.count`);
  } else if (row.kind === 'log') {
    if (!LOG_LEVELS.has(row.level)) throw new Error(`${label}.level is invalid`);
    out.level = row.level;
    out.count = integerCount(row.count, `${label}.count`);
  } else if (row.kind === 'gauge') {
    out.lastValue = finiteNumber(row.lastValue, `${label}.lastValue`);
    out.lastTimestamp = finiteNumber(row.lastTimestamp, `${label}.lastTimestamp`);
    out.min = finiteNumber(row.min, `${label}.min`);
    out.max = finiteNumber(row.max, `${label}.max`);
    out.sampleCount = integerCount(row.sampleCount, `${label}.sampleCount`);
    if (out.sampleCount < 1) throw new Error(`${label}.sampleCount must be >= 1`);
    if (out.min > out.max) throw new Error(`${label}.min must be <= max`);
  } else if (row.kind === 'histogram') {
    out.count = integerCount(row.count, `${label}.count`);
    out.sum = finiteNumber(row.sum, `${label}.sum`);
    out.min = finiteNumber(row.min, `${label}.min`);
    out.max = finiteNumber(row.max, `${label}.max`);
    if (out.min > out.max) throw new Error(`${label}.min must be <= max`);
    if (!Array.isArray(row.buckets)) throw new Error(`${label}.buckets must be an array`);
    let previous = -Infinity;
    out.buckets = row.buckets.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`${label}.buckets[${index}] must be [bound, count]`);
      const bound = finiteNumber(pair[0], `${label}.buckets[${index}][0]`);
      if (bound <= previous) throw new Error(`${label}.buckets bounds must be strictly increasing`);
      previous = bound;
      return [bound, integerCount(pair[1], `${label}.buckets[${index}][1]`)];
    });
  } else if (row.kind === 'distinct') {
    const body = normalizeHllBody({ precision: row.precision, registers: row.registers });
    out.precision = body.precision;
    out.registers = body.registers;
    out.estimate = estimateHllBody(body);
  }
  return out;
}

function stableDimensions(value) {
  return JSON.stringify(value ?? null);
}

export function historicalSeriesKey(row) {
  return [
    row.kind,
    row.role,
    row.environment,
    row.appVersion,
    row.name,
    row.level ?? '',
    stableDimensions(row.dimensions)
  ].join('\0');
}

function compatibleBounds(left, right) {
  return left.length === right.length && left.every((pair, index) => pair[0] === right[index][0]);
}

function mergeRow(existing, incoming) {
  if (existing.kind === 'counter') {
    existing.value += incoming.value;
  } else if (existing.kind === 'event' || existing.kind === 'log' || existing.kind === 'drop') {
    existing.count += incoming.count;
  } else if (existing.kind === 'gauge') {
    existing.min = Math.min(existing.min, incoming.min);
    existing.max = Math.max(existing.max, incoming.max);
    existing.sampleCount += incoming.sampleCount;
    if (
      incoming.lastTimestamp > existing.lastTimestamp ||
      (incoming.lastTimestamp === existing.lastTimestamp && incoming.lastValue > existing.lastValue)
    ) {
      existing.lastTimestamp = incoming.lastTimestamp;
      existing.lastValue = incoming.lastValue;
    }
  } else if (existing.kind === 'histogram') {
    if (!compatibleBounds(existing.buckets, incoming.buckets)) {
      throw new Error(`incompatible histogram bounds for historical series ${incoming.name}`);
    }
    existing.count += incoming.count;
    existing.sum += incoming.sum;
    existing.min = Math.min(existing.min, incoming.min);
    existing.max = Math.max(existing.max, incoming.max);
    for (let index = 0; index < existing.buckets.length; index++) {
      existing.buckets[index][1] += incoming.buckets[index][1];
    }
  } else if (existing.kind === 'distinct') {
    const body = mergeHllBodies(
      { precision: existing.precision, registers: existing.registers },
      { precision: incoming.precision, registers: incoming.registers }
    );
    existing.precision = body.precision;
    existing.registers = body.registers;
    existing.estimate = estimateHllBody(body);
  }
}

export function mergeHistoricalRow(existing, incoming) {
  if (historicalSeriesKey(existing) !== historicalSeriesKey(incoming)) {
    throw new Error('cannot merge different historical series');
  }
  const merged = structuredClone(existing);
  mergeRow(merged, incoming);
  return merged;
}

function expectedWidth(tier) {
  if (tier === 'minute') return 60_000;
  if (tier === 'hour') return 3_600_000;
  return 86_400_000;
}

export function assertHistoryBoundary(tier, from, to, label = 'history bucket') {
  if (!TIERS.has(tier)) throw new Error(`${label}.tier must be minute, hour, or day`);
  const width = expectedWidth(tier);
  if (!Number.isInteger(from) || from % width !== 0 || to !== from + width) {
    throw new Error(`${label} must have a UTC-aligned ${tier} boundary`);
  }
}

export function normalizeHistoryBucket(bucket, label = 'history bucket') {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error(`${label} must be an object`);
  assertHistoryBoundary(bucket.tier, bucket.from, bucket.to, label);
  if (!Array.isArray(bucket.rows)) throw new Error(`${label}.rows must be an array`);
  if (typeof bucket.finalized !== 'boolean') throw new Error(`${label}.finalized must be a boolean`);
  const rows = bucket.rows.map((row, index) => normalizeHistoricalRow(row, `${label}.rows[${index}]`));
  rows.sort((left, right) => historicalSeriesKey(left).localeCompare(historicalSeriesKey(right)));
  return {
    project: nonEmptyString(bucket.project, `${label}.project`),
    tier: bucket.tier,
    from: bucket.from,
    to: bucket.to,
    finalized: bucket.finalized,
    dropCount: integerCount(bucket.dropCount, `${label}.dropCount`),
    rows
  };
}

export function mergeHistoryBuckets({ project, tier, from, to, sourceBuckets, finalized }) {
  if (!Array.isArray(sourceBuckets)) throw new Error('sourceBuckets must be an array');
  const expected = normalizeHistoryBucket({ project, tier, from, to, finalized, dropCount: 0, rows: [] });
  const merged = new Map();
  let dropCount = 0;
  for (let index = 0; index < sourceBuckets.length; index++) {
    const source = normalizeHistoryBucket(sourceBuckets[index], `sourceBuckets[${index}]`);
    if (source.project !== project || source.from < from || source.to > to) {
      throw new Error('source bucket falls outside the destination bucket');
    }
    dropCount += source.dropCount;
    for (const incoming of source.rows) {
      const key = historicalSeriesKey(incoming);
      const existing = merged.get(key);
      if (!existing) merged.set(key, structuredClone(incoming));
      else mergeRow(existing, incoming);
    }
  }
  expected.dropCount = dropCount;
  expected.rows = [...merged.values()].sort((left, right) =>
    historicalSeriesKey(left).localeCompare(historicalSeriesKey(right))
  );
  return expected;
}
