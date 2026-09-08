import {
  historicalSeriesKey,
  mergeHistoricalRow,
  normalizeHistoryBucket
} from './HistoryBucket.js';
import { utcBucketStart } from './HistoricalCompactor.js';

function historyRows(envelope, frame, persistLogs) {
  const { role, environment, appVersion } = envelope.client;
  const common = { role, environment, appVersion };
  const rows = [];
  for (const [name, dimensions, value] of frame.metrics.counters) {
    rows.push({ kind: 'counter', name, dimensions, value, ...common });
  }
  for (const [name, dimensions, value, timestamp] of frame.metrics.gauges) {
    rows.push({
      kind: 'gauge',
      name,
      dimensions,
      lastValue: value,
      lastTimestamp: timestamp,
      min: value,
      max: value,
      sampleCount: 1,
      ...common
    });
  }
  for (const [name, dimensions, body] of frame.metrics.histograms) {
    rows.push({
      kind: 'histogram',
      name,
      dimensions,
      count: body.count,
      sum: body.sum,
      min: body.min,
      max: body.max,
      buckets: body.buckets,
      ...common
    });
  }
  for (const [name, dimensions, body] of frame.metrics.distincts || []) {
    rows.push({ kind: 'distinct', name, dimensions, ...body, ...common });
  }
  for (const event of frame.events) {
    rows.push({ kind: 'event', name: event[1], dimensions: null, count: 1, ...common });
  }
  const allowedLogs = new Set(persistLogs);
  for (const log of frame.logs) {
    if (!allowedLogs.has(log[2])) continue;
    rows.push({ kind: 'log', name: log[2], level: log[1], dimensions: null, count: 1, ...common });
  }
  return rows;
}

function bucketBytes(bucket) {
  return Buffer.byteLength(JSON.stringify(bucket));
}

function rowBytes(row) {
  return Buffer.byteLength(JSON.stringify(row));
}

function emptyState(project, from) {
  return {
    rows: new Map(),
    rowBytes: new Map(),
    bytes: bucketBytes({
      project,
      tier: 'minute',
      from,
      to: from + 60_000,
      finalized: false,
      dropCount: 0,
      rows: []
    })
  };
}

function stateFromBucket(bucket) {
  const state = emptyState(bucket.project, bucket.from);
  for (const row of bucket.rows) {
    const key = historicalSeriesKey(row);
    const bytes = rowBytes(row);
    if (state.rows.size > 0) state.bytes += 1;
    state.rows.set(key, row);
    state.rowBytes.set(key, bytes);
    state.bytes += bytes;
  }
  return state;
}

export class HistoryAccumulator {
  constructor({ project, clockSkewAllowanceMs, maxAppVersionsPerProjectRoleTier }) {
    if (typeof project !== 'string' || project.length === 0) throw new Error('history project is required');
    if (!Number.isInteger(clockSkewAllowanceMs) || clockSkewAllowanceMs < 1) {
      throw new Error('history clockSkewAllowanceMs must be an integer >= 1');
    }
    if (!Number.isInteger(maxAppVersionsPerProjectRoleTier) || maxAppVersionsPerProjectRoleTier < 1) {
      throw new Error('history maxAppVersionsPerProjectRoleTier must be an integer >= 1');
    }
    this.project = project;
    this.clockSkewAllowanceMs = clockSkewAllowanceMs;
    this.maxAppVersions = maxAppVersionsPerProjectRoleTier;
    this.states = new Map();
    this.dirty = new Set();
    this.versionsByRole = new Map();
  }

  seed(buckets) {
    if (!Array.isArray(buckets)) throw new Error('history seed buckets must be an array');
    for (const bucket of buckets) {
      const normalized = normalizeHistoryBucket(bucket);
      if (normalized.project !== this.project) {
        throw new Error('history seed must contain buckets for this project');
      }
      if (normalized.tier === 'minute') this.states.set(normalized.from, stateFromBucket(normalized));
      for (const row of normalized.rows) this._rememberVersion(normalized.tier, row.role, row.appVersion);
    }
  }

  _rememberVersion(tier, role, appVersion) {
    const key = `${tier}\0${role}`;
    let versions = this.versionsByRole.get(key);
    if (!versions) {
      versions = new Set();
      this.versionsByRole.set(key, versions);
    }
    versions.add(appVersion);
  }

  ingest(envelope, persistLogs) {
    const prepared = this.prepare(envelope, persistLogs);
    this.commit(prepared);
    return prepared.updates.length > 0;
  }

  prepare(envelope, persistLogs) {
    const role = envelope.client.role;
    const appVersion = envelope.client.appVersion;
    const versions = this.versionsByRole.get(`minute\0${role}`);
    if (versions && !versions.has(appVersion) && versions.size >= this.maxAppVersions) {
      throw new Error(`historical app-version cap exceeded for role ${role}`);
    }
    const updates = new Map();
    for (const frame of envelope.frames) {
      const from = utcBucketStart(frame.from, 'minute');
      const incoming = normalizeHistoryBucket({
        project: this.project,
        tier: 'minute',
        from,
        to: from + 60_000,
        finalized: false,
        dropCount: 0,
        rows: historyRows(envelope, frame, persistLogs)
      });
      const base = this.states.get(from) || emptyState(this.project, from);
      let update = updates.get(from);
      if (!update) {
        update = { from, rows: new Map(), rowBytes: new Map(), projectedBytes: base.bytes, added: 0 };
        updates.set(from, update);
      }
      for (const row of incoming.rows) {
        const key = historicalSeriesKey(row);
        const current = update.rows.get(key) || base.rows.get(key);
        const merged = current ? mergeHistoricalRow(current, row) : structuredClone(row);
        const previousBytes = update.rowBytes.get(key) ?? base.rowBytes.get(key);
        const nextBytes = rowBytes(merged);
        if (previousBytes === undefined) {
          if (base.rows.size + update.added > 0) update.projectedBytes += 1;
          update.added += 1;
          update.projectedBytes += nextBytes;
        } else {
          update.projectedBytes += nextBytes - previousBytes;
        }
        update.rows.set(key, merged);
        update.rowBytes.set(key, nextBytes);
      }
    }
    return {
      role,
      appVersion,
      updates: [...updates.values()].map((update) => ({
        from: update.from,
        rows: [...update.rows.entries()],
        rowBytes: [...update.rowBytes.entries()],
        projectedBytes: update.projectedBytes
      }))
    };
  }

  commit(prepared) {
    const { role, appVersion, updates } = prepared;
    this._rememberVersion('minute', role, appVersion);
    for (const update of updates) {
      let state = this.states.get(update.from);
      if (!state) {
        state = emptyState(this.project, update.from);
        this.states.set(update.from, state);
      }
      for (const [key, row] of update.rows) state.rows.set(key, row);
      for (const [key, bytes] of update.rowBytes) state.rowBytes.set(key, bytes);
      state.bytes = update.projectedBytes;
      this.dirty.add(update.from);
    }
  }

  pending(now = Date.now()) {
    return [...this.dirty]
      .sort((left, right) => left - right)
      .map((from) => {
        const state = this.states.get(from);
        return {
          project: this.project,
          tier: 'minute',
          from,
          to: from + 60_000,
          finalized: now >= from + 60_000 + this.clockSkewAllowanceMs,
          dropCount: 0,
          rows: [...state.rows.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, row]) => structuredClone(row))
        };
      });
  }

  acknowledge(buckets) {
    for (const bucket of buckets) this.dirty.delete(bucket.from);
  }

  prunePersisted(through) {
    for (const from of this.states.keys()) {
      if (from + 60_000 <= through && !this.dirty.has(from)) this.states.delete(from);
    }
  }

  projectedPending(prepared) {
    const pending = new Map();
    for (const from of this.dirty) pending.set(from, this.states.get(from).bytes);
    for (const update of prepared.updates) pending.set(update.from, update.projectedBytes);
    let bytes = 0;
    for (const value of pending.values()) bytes += value;
    return { batches: pending.size, bytes };
  }
}
