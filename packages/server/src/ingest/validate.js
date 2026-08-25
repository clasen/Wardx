import { roleSees } from '../roles.js';

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function unknownKey(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${label} unknown key: ${key}`;
  }
  return null;
}

function validateNonEmptyString(value, label, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) return `${label} must be a non-empty string`;
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    return `${label} must be at most ${maxBytes} UTF-8 bytes`;
  }
  return null;
}

function validateJsonValue(value, label, limits) {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    if (value.length > limits.maxAttributeValueLength) {
      return `${label} must be at most ${limits.maxAttributeValueLength} characters`;
    }
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${label} must contain only finite numbers`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const invalid = validateJsonValue(value[i], `${label}[${i}]`, limits);
      if (invalid) return invalid;
    }
    return null;
  }
  if (!isObject(value)) return `${label} must contain only JSON values`;
  if (Object.keys(value).length > limits.maxAttributeKeys) {
    return `${label} must contain at most ${limits.maxAttributeKeys} keys`;
  }
  for (const [key, item] of Object.entries(value)) {
    const invalidKey = validateNonEmptyString(key, `${label} key`, limits.maxNameBytes);
    if (invalidKey) return invalidKey;
    const invalid = validateJsonValue(item, `${label}.${key}`, limits);
    if (invalid) return invalid;
  }
  return null;
}

function validateAttrs(attrs, label, limits) {
  if (attrs === null) return null;
  if (!isObject(attrs)) return `${label} must be an object or null`;
  return validateJsonValue(attrs, label, limits);
}

function validateDimensions(dims, label, limits) {
  if (dims === null) return null;
  if (!isObject(dims)) return `${label} must be an object or null`;
  if (Object.keys(dims).length > limits.maxDimensionKeys) {
    return `${label} must contain at most ${limits.maxDimensionKeys} keys`;
  }
  for (const [key, value] of Object.entries(dims)) {
    const invalidKey = validateNonEmptyString(key, `${label} key`, limits.maxNameBytes);
    if (invalidKey) return invalidKey;
    const type = typeof value;
    if (type !== 'string' && type !== 'boolean' && !(type === 'number' && Number.isFinite(value))) {
      return `${label}.${key} must be a string, finite number, or boolean`;
    }
    if (String(value).length > limits.maxDimensionValueLength) {
      return `${label}.${key} must be at most ${limits.maxDimensionValueLength} characters`;
    }
  }
  return null;
}

function validateCounter(row, label, limits) {
  if (!Array.isArray(row) || row.length !== 3) return `${label} must be a 3-item tuple`;
  const invalidName = validateNonEmptyString(row[0], `${label}[0]`, limits.maxNameBytes);
  if (invalidName) return invalidName;
  const invalidDims = validateDimensions(row[1], `${label}[1]`, limits);
  if (invalidDims) return invalidDims;
  if (!isFiniteNumber(row[2])) return `${label}[2] must be a finite number`;
  return null;
}

function validateTimestamp(value, label, earliestTimestamp, latestTimestamp) {
  if (!isFiniteNumber(value)) return `${label} must be a finite timestamp`;
  if (value < earliestTimestamp) return `${label} exceeds history.maxAcceptedPastAgeMs`;
  if (value > latestTimestamp) return `${label} exceeds maxClockSkewMs`;
  return null;
}

function validateGauge(row, label, limits, earliestTimestamp, latestTimestamp) {
  if (!Array.isArray(row) || row.length !== 4) return `${label} must be a 4-item tuple`;
  const invalidName = validateNonEmptyString(row[0], `${label}[0]`, limits.maxNameBytes);
  if (invalidName) return invalidName;
  const invalidDims = validateDimensions(row[1], `${label}[1]`, limits);
  if (invalidDims) return invalidDims;
  if (!isFiniteNumber(row[2])) return `${label}[2] must be a finite number`;
  return validateTimestamp(row[3], `${label}[3]`, earliestTimestamp, latestTimestamp);
}

function validateHistogramBody(body, label, limits) {
  if (!isObject(body)) return `${label} must be an object`;
  const invalidKey = unknownKey(body, new Set(['count', 'sum', 'min', 'max', 'buckets', 'exemplar']), label);
  if (invalidKey) return invalidKey;
  if (!Number.isInteger(body.count) || body.count < 1) return `${label}.count must be an integer >= 1`;
  if (!isFiniteNumber(body.sum)) return `${label}.sum must be a finite number`;
  if (!isFiniteNumber(body.min)) return `${label}.min must be a finite number`;
  if (!isFiniteNumber(body.max)) return `${label}.max must be a finite number`;
  if (body.min > body.max) return `${label}.min must be <= max`;
  if (!Array.isArray(body.buckets)) return `${label}.buckets must be an array`;
  let previousBound = -Infinity;
  let bucketTotal = 0;
  for (let i = 0; i < body.buckets.length; i++) {
    const bucket = body.buckets[i];
    const bucketLabel = `${label}.buckets[${i}]`;
    if (!Array.isArray(bucket) || bucket.length !== 2) return `${bucketLabel} must be a 2-item tuple`;
    if (!isFiniteNumber(bucket[0]) || bucket[0] <= previousBound) {
      return `${label}.buckets bounds must be strictly increasing finite numbers`;
    }
    if (!Number.isInteger(bucket[1]) || bucket[1] < 0) {
      return `${bucketLabel}[1] must be an integer >= 0`;
    }
    previousBound = bucket[0];
    bucketTotal += bucket[1];
  }
  if (bucketTotal > body.count) return `${label}.buckets total must be <= count`;
  if (body.exemplar !== undefined) {
    if (!isObject(body.exemplar)) return `${label}.exemplar must be an object`;
    const invalidExemplarKey = unknownKey(body.exemplar, new Set(['value', 'attrs']), `${label}.exemplar`);
    if (invalidExemplarKey) return invalidExemplarKey;
    if (!isFiniteNumber(body.exemplar.value)) return `${label}.exemplar.value must be a finite number`;
    if (body.exemplar.value !== body.max) return `${label}.exemplar.value must equal max`;
    const invalidAttrs = validateAttrs(body.exemplar.attrs, `${label}.exemplar.attrs`, limits);
    if (invalidAttrs) return invalidAttrs;
  }
  return null;
}

function validateHistogram(row, label, limits) {
  if (!Array.isArray(row) || row.length !== 3) return `${label} must be a 3-item tuple`;
  const invalidName = validateNonEmptyString(row[0], `${label}[0]`, limits.maxNameBytes);
  if (invalidName) return invalidName;
  const invalidDims = validateDimensions(row[1], `${label}[1]`, limits);
  if (invalidDims) return invalidDims;
  return validateHistogramBody(row[2], `${label}[2]`, limits);
}

function validateEvent(row, label, limits, earliestTimestamp, latestTimestamp) {
  if (!Array.isArray(row) || row.length !== 3) return `${label} must be a 3-item tuple`;
  const invalidTimestamp = validateTimestamp(row[0], `${label}[0]`, earliestTimestamp, latestTimestamp);
  if (invalidTimestamp) return invalidTimestamp;
  const invalidName = validateNonEmptyString(row[1], `${label}[1]`, limits.maxNameBytes);
  if (invalidName) return invalidName;
  return validateAttrs(row[2], `${label}[2]`, limits);
}

function validateLog(row, label, limits, earliestTimestamp, latestTimestamp) {
  if (!Array.isArray(row) || row.length !== 4) return `${label} must be a 4-item tuple`;
  const invalidTimestamp = validateTimestamp(row[0], `${label}[0]`, earliestTimestamp, latestTimestamp);
  if (invalidTimestamp) return invalidTimestamp;
  if (!LOG_LEVELS.has(row[1])) return `${label}[1] must be a supported log level`;
  const invalidMessage = validateNonEmptyString(row[2], `${label}[2]`, limits.maxNameBytes);
  if (invalidMessage) return invalidMessage;
  return validateAttrs(row[3], `${label}[3]`, limits);
}

function validateRows(rows, label, validateRow) {
  if (!Array.isArray(rows)) return `${label} must be an array`;
  for (let i = 0; i < rows.length; i++) {
    const invalid = validateRow(rows[i], `${label}[${i}]`);
    if (invalid) return invalid;
  }
  return null;
}

export function validateEnvelope(body, limits) {
  if (!limits) throw new Error('wire validation limits are required');
  if (!isObject(body)) return 'body must be an object';
  const invalidBodyKey = unknownKey(
    body,
    new Set(['protocol', 'project', 'sdk', 'client', 'configVersion', 'frames']),
    'body'
  );
  if (invalidBodyKey) return invalidBodyKey;
  if (body.protocol !== 1) return 'protocol must be 1';
  const invalidProject = validateNonEmptyString(body.project, 'project', limits.maxNameBytes);
  if (invalidProject) return invalidProject;
  if (!isObject(body.sdk)) return 'sdk is required';
  const invalidSdkKey = unknownKey(body.sdk, new Set(['name', 'version']), 'sdk');
  if (invalidSdkKey) return invalidSdkKey;
  for (const key of ['name', 'version']) {
    const invalid = validateNonEmptyString(body.sdk[key], `sdk.${key}`, limits.maxNameBytes);
    if (invalid) return invalid;
  }
  if (!isObject(body.client)) return 'client is required';
  const invalidClientKey = unknownKey(
    body.client,
    new Set(['instanceId', 'sessionId', 'role', 'appVersion', 'environment', 'platform']),
    'client'
  );
  if (invalidClientKey) return invalidClientKey;
  for (const key of ['instanceId', 'sessionId']) {
    const invalid = validateNonEmptyString(body.client[key], `client.${key}`, limits.maxNameBytes);
    if (invalid) return invalid;
  }
  const invalidRole = validateNonEmptyString(body.client.role, 'client.role', limits.maxNameBytes);
  if (invalidRole) return 'client.role is required';
  if (body.client.role === '*') return 'client.role cannot be *';
  for (const key of ['appVersion', 'environment', 'platform']) {
    const invalid = validateNonEmptyString(body.client[key], `client.${key}`, limits.maxNameBytes);
    if (invalid) return invalid;
  }
  if (!Number.isInteger(body.configVersion) || body.configVersion < 0) {
    return 'configVersion must be an integer >= 0';
  }
  if (!Array.isArray(body.frames)) return 'frames must be an array';
  if (body.frames.length > limits.maxFramesPerEnvelope) {
    return `frames must contain at most ${limits.maxFramesPerEnvelope} items`;
  }
  const latestTimestamp = Date.now() + limits.maxClockSkewMs;
  const earliestTimestamp = Date.now() - limits.history.maxAcceptedPastAgeMs;
  let itemCount = 0;
  for (let i = 0; i < body.frames.length; i++) {
    const frame = body.frames[i];
    const label = `frames[${i}]`;
    if (!isObject(frame)) return `${label} must be an object`;
    const invalidFrameKey = unknownKey(frame, new Set(['seq', 'from', 'to', 'metrics', 'events', 'logs']), label);
    if (invalidFrameKey) return invalidFrameKey;
    if (!Number.isInteger(frame.seq) || frame.seq < 1) return `${label}.seq must be an integer >= 1`;
    const invalidFrom = validateTimestamp(frame.from, `${label}.from`, earliestTimestamp, latestTimestamp);
    if (invalidFrom) return invalidFrom;
    const invalidTo = validateTimestamp(frame.to, `${label}.to`, earliestTimestamp, latestTimestamp);
    if (invalidTo) return invalidTo;
    if (frame.from > frame.to) return `${label}.from must be <= to`;
    if (!isObject(frame.metrics)) return `${label}.metrics is required`;
    const invalidMetricsKey = unknownKey(
      frame.metrics,
      new Set(['counters', 'gauges', 'histograms']),
      `${label}.metrics`
    );
    if (invalidMetricsKey) return invalidMetricsKey;
    for (const rows of [
      frame.metrics.counters,
      frame.metrics.gauges,
      frame.metrics.histograms,
      frame.events,
      frame.logs
    ]) {
      if (Array.isArray(rows)) itemCount += rows.length;
    }
    if (itemCount > limits.maxItemsPerEnvelope) {
      return `envelope collections must contain at most ${limits.maxItemsPerEnvelope} items`;
    }
    const invalidCounters = validateRows(frame.metrics.counters, `${label}.metrics.counters`, (row, rowLabel) =>
      validateCounter(row, rowLabel, limits)
    );
    if (invalidCounters) return invalidCounters;
    const invalidGauges = validateRows(frame.metrics.gauges, `${label}.metrics.gauges`, (row, rowLabel) =>
      validateGauge(row, rowLabel, limits, earliestTimestamp, latestTimestamp)
    );
    if (invalidGauges) return invalidGauges;
    const invalidHistograms = validateRows(
      frame.metrics.histograms,
      `${label}.metrics.histograms`,
      (row, rowLabel) => validateHistogram(row, rowLabel, limits)
    );
    if (invalidHistograms) return invalidHistograms;
    const invalidEvents = validateRows(frame.events, `${label}.events`, (row, rowLabel) =>
      validateEvent(row, rowLabel, limits, earliestTimestamp, latestTimestamp)
    );
    if (invalidEvents) return invalidEvents;
    const invalidLogs = validateRows(frame.logs, `${label}.logs`, (row, rowLabel) =>
      validateLog(row, rowLabel, limits, earliestTimestamp, latestTimestamp)
    );
    if (invalidLogs) return invalidLogs;
  }
  return null;
}

export function validateExperimentEvents(body, experiments) {
  const byId = new Map(experiments.map((experiment) => [experiment.id, experiment]));
  const role = body.client.role;
  for (let frameIndex = 0; frameIndex < body.frames.length; frameIndex++) {
    const events = body.frames[frameIndex].events;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const row = events[eventIndex];
      const name = row[1];
      if (name !== 'experiment.exposure' && name !== 'experiment.goal') continue;
      const label = `frames[${frameIndex}].events[${eventIndex}][2]`;
      const attrs = row[2];
      if (!isObject(attrs)) return `${label} must be an object`;
      if (name === 'experiment.exposure') {
        const invalidKey = unknownKey(attrs, new Set(['experiment', 'variant', 'subject']), label);
        if (invalidKey) return invalidKey;
        for (const key of ['experiment', 'variant', 'subject']) {
          const invalid = validateNonEmptyString(attrs[key], `${label}.${key}`);
          if (invalid) return invalid;
        }
        if (!/^[0-9a-f]{64}$/.test(attrs.subject)) return `${label}.subject must be a 256-bit lowercase hex hash`;
      const definition = byId.get(attrs.experiment);
      if (!definition) return `${label}.experiment is unknown`;
      if (!definition.enabled) return `${label}.experiment is disabled`;
        if (!roleSees(definition.roles, role)) return `${label}.experiment is not visible to client.role`;
        if (!definition.variants.some((variant) => variant.key === attrs.variant)) {
          return `${label}.variant is unknown`;
        }
        continue;
      }
      const invalidKey = unknownKey(attrs, new Set(['metric', 'subject', 'experiments', 'value']), label);
      if (invalidKey) return invalidKey;
      for (const key of ['metric', 'subject']) {
        const invalid = validateNonEmptyString(attrs[key], `${label}.${key}`);
        if (invalid) return invalid;
      }
      if (!/^[0-9a-f]{64}$/.test(attrs.subject)) return `${label}.subject must be a 256-bit lowercase hex hash`;
      if (!Array.isArray(attrs.experiments) || attrs.experiments.length !== 1) {
        return `${label}.experiments must contain exactly one assignment`;
      }
      if (attrs.value !== undefined && !isFiniteNumber(attrs.value)) {
        return `${label}.value must be a finite number`;
      }
      const assignment = attrs.experiments[0];
      if (!isObject(assignment)) return `${label}.experiments[0] must be an object`;
      const invalidAssignmentKey = unknownKey(
        assignment,
        new Set(['experiment', 'variant']),
        `${label}.experiments[0]`
      );
      if (invalidAssignmentKey) return invalidAssignmentKey;
      for (const key of ['experiment', 'variant']) {
        const invalid = validateNonEmptyString(assignment[key], `${label}.experiments[0].${key}`);
        if (invalid) return invalid;
      }
      const definition = byId.get(assignment.experiment);
      if (!definition) return `${label}.experiments[0].experiment is unknown`;
      if (!definition.enabled) return `${label}.experiments[0].experiment is disabled`;
      if (!roleSees(definition.roles, role)) return `${label}.experiments[0].experiment is not visible to client.role`;
      if (definition.goalMetric !== attrs.metric) return `${label}.metric does not match experiment.goalMetric`;
      if (!definition.variants.some((variant) => variant.key === assignment.variant)) {
        return `${label}.experiments[0].variant is unknown`;
      }
    }
  }
  return null;
}
