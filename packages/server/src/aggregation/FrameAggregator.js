import { estimateHllBody, mergeHllBodies, normalizeHllBody } from './HyperLogLog.js';

function dimKey(dims) {
  if (dims == null) return '';
  const keys = Object.keys(dims);
  keys.sort();
  let out = '';
  for (let i = 0; i < keys.length; i++) {
    out += keys[i] + '=' + String(dims[keys[i]]) + '\n';
  }
  return out;
}

function seriesKey(role, name, dims) {
  return role + '\0' + name + '\0' + dimKey(dims);
}

function eventKey(role, name) {
  return role + '\0' + name;
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function persistLogKey(role, level, name) {
  return role + '\0' + level + '\0' + name;
}

function copyLogAttrs(attrs) {
  if (attrs == null) return null;
  if (typeof attrs !== 'object' || Array.isArray(attrs)) return null;
  return { ...attrs };
}

function copyLogExemplar(exemplar) {
  if (!exemplar || typeof exemplar !== 'object') return null;
  if (typeof exemplar.ts !== 'number' || !Number.isFinite(exemplar.ts)) return null;
  if (typeof exemplar.instanceId !== 'string' || exemplar.instanceId.length === 0) return null;
  return {
    ts: exemplar.ts,
    attrs: copyLogAttrs(exemplar.attrs),
    instanceId: exemplar.instanceId
  };
}

function allowedPersistLogs(names) {
  if (names === undefined || names === null) return null;
  if (names instanceof Set) return names.size === 0 ? null : names;
  if (!Array.isArray(names)) throw new Error('persistLogs must be an array of strings');
  if (names.length === 0) return null;
  return new Set(names);
}

function bumpPersistLog(map, key, name, level, role, exemplar) {
  const prev = map.get(key);
  const copied = copyLogExemplar(exemplar);
  if (!prev) {
    map.set(key, { name, level, role, count: 1, exemplar: copied });
    return;
  }
  prev.count += 1;
  if (copied && (!prev.exemplar || copied.ts >= prev.exemplar.ts)) prev.exemplar = copied;
}

function ingestPersistLogs(window, lifetime, logs, role, instanceId, allowed) {
  if (!allowed) return false;
  if (typeof instanceId !== 'string' || instanceId.length === 0) return false;
  let changed = false;
  for (const row of logs) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const ts = row[0];
    const level = row[1];
    const message = row[2];
    if (!LOG_LEVELS.has(level)) continue;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    if (typeof message !== 'string' || message.length === 0) continue;
    if (!allowed.has(message)) continue;
    const exemplar = { ts, attrs: copyLogAttrs(row[3]), instanceId };
    const key = persistLogKey(role, level, message);
    bumpPersistLog(window.logNames, key, message, level, role, exemplar);
    bumpPersistLog(lifetime, key, message, level, role, exemplar);
    changed = true;
  }
  return changed;
}

function serializePersistLog(row) {
  const out = { name: row.name, level: row.level, role: row.role, count: row.count, persist: true };
  if (row.exemplar) out.exemplar = copyLogExemplar(row.exemplar);
  return out;
}

function cloneHistogramBody(body) {
  if (!body) return null;
  const out = {
    count: body.count,
    sum: body.sum,
    min: body.min,
    max: body.max,
    buckets: body.buckets.map((pair) => [pair[0], pair[1]])
  };
  const exemplar = copyExemplar(body.exemplar);
  if (exemplar) out.exemplar = exemplar;
  return out;
}

function cloneDims(dims) {
  if (dims == null) return null;
  return { ...dims };
}

function durableLogRow(row) {
  const out = { name: row.name, level: row.level, role: row.role, count: row.count };
  if (row.exemplar) out.exemplar = copyLogExemplar(row.exemplar);
  return out;
}

function putSeries(map, byName, key, capKey, row) {
  map.set(key, row);
  if (!byName.has(capKey)) byName.set(capKey, 0);
  byName.set(capKey, byName.get(capKey) + 1);
}

function minuteFloor(ts) {
  return Math.floor(ts / 60000) * 60000;
}

function copyExemplar(exemplar) {
  if (!exemplar || typeof exemplar !== 'object') return null;
  if (typeof exemplar.value !== 'number' || !Number.isFinite(exemplar.value)) return null;
  const attrs = exemplar.attrs == null ? null : exemplar.attrs;
  return { value: exemplar.value, attrs };
}

function applyExemplar(body, incoming) {
  const exemplar = copyExemplar(incoming.exemplar);
  if (exemplar) body.exemplar = exemplar;
  else delete body.exemplar;
}

function mergeHistogram(existing, incoming) {
  if (!existing) {
    const body = {
      count: incoming.count,
      sum: incoming.sum,
      min: incoming.min,
      max: incoming.max,
      buckets: incoming.buckets.map((pair) => [pair[0], pair[1]])
    };
    applyExemplar(body, incoming);
    return body;
  }
  existing.count += incoming.count;
  existing.sum += incoming.sum;
  if (incoming.min < existing.min) existing.min = incoming.min;
  if (incoming.max > existing.max) {
    existing.max = incoming.max;
    applyExemplar(existing, incoming);
  } else if (incoming.max === existing.max) {
    const exemplar = copyExemplar(incoming.exemplar);
    if (exemplar) existing.exemplar = exemplar;
  }
  const byBound = new Map(existing.buckets);
  for (const [bound, count] of incoming.buckets) {
    byBound.set(bound, (byBound.get(bound) || 0) + count);
  }
  existing.buckets = [...byBound.entries()].sort((a, b) => a[0] - b[0]);
  return existing;
}

function experimentSlot(map, experimentId, variantKey) {
  let byVariant = map.get(experimentId);
  if (!byVariant) {
    byVariant = new Map();
    map.set(experimentId, byVariant);
  }
  let row = byVariant.get(variantKey);
  if (!row) {
    row = { exposures: 0, goals: 0, goalSum: 0, goalSumSq: 0 };
    byVariant.set(variantKey, row);
  }
  return row;
}

function addGoal(slot, value) {
  slot.goals += 1;
  slot.goalSum += value;
  slot.goalSumSq += value * value;
}

function ingestExperimentEvents(window, lifetime, events, role) {
  let changed = false;
  for (const row of events) {
    const name = row[1];
    const key = eventKey(role, name);
    const prev = window.eventNames.get(key);
    if (!prev) window.eventNames.set(key, { name, role, count: 1 });
    else prev.count += 1;
    const attrs = row[2] && typeof row[2] === 'object' ? row[2] : {};
    if (name === 'experiment.exposure') {
      if (typeof attrs.experiment === 'string' && typeof attrs.variant === 'string') {
        experimentSlot(window.experiments, attrs.experiment, attrs.variant).exposures += 1;
        experimentSlot(lifetime, attrs.experiment, attrs.variant).exposures += 1;
        changed = true;
      }
      continue;
    }
    if (name !== 'experiment.goal') continue;
    const assignments = Array.isArray(attrs.experiments) ? attrs.experiments : [];
    if (assignments.length !== 1) continue;
    const value = typeof attrs.value === 'number' && Number.isFinite(attrs.value) ? attrs.value : 1;
    const item = assignments[0];
    if (!item || typeof item.experiment !== 'string' || typeof item.variant !== 'string') continue;
    addGoal(experimentSlot(window.experiments, item.experiment, item.variant), value);
    addGoal(experimentSlot(lifetime, item.experiment, item.variant), value);
    changed = true;
  }
  return changed;
}

function nameSet(names) {
  if (names === undefined || names === null) return null;
  if (!Array.isArray(names)) throw new Error('names must be an array of strings');
  return new Set(names);
}

function filterByName(rows, names) {
  if (!names) return rows;
  return rows.filter((row) => names.has(row.name));
}

function filterByRole(rows, role) {
  if (!role) return rows;
  return rows.filter((row) => row.role === role);
}

function withDerived(row) {
  return {
    ...row,
    goalMean: row.goals > 0 ? row.goalSum / row.goals : 0,
    rate: row.exposures > 0 ? row.goals / row.exposures : 0
  };
}

function serializeExperiments(map, names) {
  const out = [];
  for (const [id, byVariant] of map) {
    if (names && !names.has(id)) continue;
    const variants = [];
    for (const [key, stats] of byVariant) {
      variants.push(
        withDerived({
          key,
          exposures: stats.exposures,
          goals: stats.goals,
          goalSum: stats.goalSum,
          goalSumSq: stats.goalSumSq
        })
      );
    }
    out.push({ id, variants });
  }
  return out;
}

function emptyWindow(minute) {
  return {
    from: minute,
    to: minute + 60000,
    counters: new Map(),
    gauges: new Map(),
    histograms: new Map(),
    distincts: new Map(),
    counterSeriesByName: new Map(),
    gaugeSeriesByName: new Map(),
    histogramSeriesByName: new Map(),
    distinctSeriesByName: new Map(),
    eventNames: new Map(),
    logNames: new Map(),
    experiments: new Map(),
    events: 0,
    logs: 0,
    frames: 0,
    cardinalityDropped: 0,
    roleStats: new Map()
  };
}

function admitSeries(map, byName, capKey, key, max) {
  if (map.has(key)) return true;
  const n = byName.get(capKey) || 0;
  if (n >= max) return false;
  byName.set(capKey, n + 1);
  return true;
}

const OUTCOME_ORDER = {
  counter: (a, b) => b.value - a.value,
  event: (a, b) => b.count - a.count,
  histogram: (a, b) => b.max - a.max || b.count - a.count,
  log: (a, b) => b.count - a.count || a.name.localeCompare(b.name)
};

export function rankOutcomes(rows, kind, limit) {
  const compare = OUTCOME_ORDER[kind];
  if (!Number.isInteger(limit) || limit < 0 || limit >= rows.length) {
    const ranked = rows.slice().sort(compare);
    return limit === undefined || limit === null ? ranked : ranked.slice(0, limit);
  }
  if (limit === 0) return [];
  const heap = [];
  const order = (a, b) => compare(a.row, b.row) || a.index - b.index;
  for (let index = 0; index < rows.length; index++) {
    const entry = { row: rows[index], index };
    if (heap.length < limit) {
      let child = heap.length;
      heap.push(entry);
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (order(heap[parent], entry) >= 0) break;
        heap[child] = heap[parent];
        child = parent;
      }
      heap[child] = entry;
    } else if (order(entry, heap[0]) < 0) {
      let parent = 0;
      while (parent * 2 + 1 < heap.length) {
        let child = parent * 2 + 1;
        if (child + 1 < heap.length && order(heap[child + 1], heap[child]) > 0) child++;
        if (order(entry, heap[child]) >= 0) break;
        heap[parent] = heap[child];
        parent = child;
      }
      heap[parent] = entry;
    }
  }
  return heap.sort(order).map((entry) => entry.row);
}

export class FrameAggregator {
  constructor({ aggregateRetentionMinutes, aggregateMaxSeriesPerMetric }) {
    if (!Number.isInteger(aggregateRetentionMinutes) || aggregateRetentionMinutes < 1) {
      throw new Error('aggregateRetentionMinutes must be an integer >= 1');
    }
    if (!Number.isInteger(aggregateMaxSeriesPerMetric) || aggregateMaxSeriesPerMetric < 1) {
      throw new Error('aggregateMaxSeriesPerMetric must be an integer >= 1');
    }
    this.retentionMs = aggregateRetentionMinutes * 60000;
    this.maxSeriesPerMetric = aggregateMaxSeriesPerMetric;
    this.windows = new Map();
    this.lifetime = new Map();
    this.persistLogLifetime = new Map();
  }

  lifetimeSnapshot() {
    const experiments = {};
    for (const [id, byVariant] of this.lifetime) {
      const variants = {};
      for (const [key, stats] of byVariant) {
        variants[key] = {
          exposures: stats.exposures,
          goals: stats.goals,
          goalSum: stats.goalSum,
          goalSumSq: stats.goalSumSq
        };
      }
      experiments[id] = variants;
    }
    return experiments;
  }

  replaceLifetime(experiments) {
    this.lifetime = new Map();
    if (experiments === undefined || experiments === null) return;
    if (typeof experiments !== 'object' || Array.isArray(experiments)) {
      throw new Error('experiment lifetime must be an object');
    }
    for (const [id, variants] of Object.entries(experiments)) {
      const byVariant = new Map();
      for (const [key, stats] of Object.entries(variants)) {
        byVariant.set(key, {
          exposures: stats.exposures,
          goals: stats.goals,
          goalSum: stats.goalSum,
          goalSumSq: stats.goalSumSq
        });
      }
      this.lifetime.set(id, byVariant);
    }
  }

  persistLogSnapshot() {
    const logs = {};
    for (const row of this.persistLogLifetime.values()) {
      if (!logs[row.name]) logs[row.name] = {};
      if (!logs[row.name][row.role]) logs[row.name][row.role] = {};
      const slot = { count: row.count };
      if (row.exemplar) slot.exemplar = copyLogExemplar(row.exemplar);
      logs[row.name][row.role][row.level] = slot;
    }
    return logs;
  }

  replacePersistLogs(logs) {
    this.persistLogLifetime = new Map();
    if (logs === undefined || logs === null) return;
    if (typeof logs !== 'object' || Array.isArray(logs)) {
      throw new Error('persist log lifetime must be an object');
    }
    for (const [name, byRole] of Object.entries(logs)) {
      for (const [role, byLevel] of Object.entries(byRole)) {
        for (const [level, stats] of Object.entries(byLevel)) {
          const key = persistLogKey(role, level, name);
          const row = { name, level, role, count: stats.count };
          const exemplar = copyLogExemplar(stats.exemplar);
          if (exemplar) row.exemplar = exemplar;
          this.persistLogLifetime.set(key, row);
        }
      }
    }
  }

  forgetPersistLog(name) {
    let changed = false;
    for (const [key, row] of this.persistLogLifetime) {
      if (row.name === name) {
        this.persistLogLifetime.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  ingest(envelope, persistLogs) {
    const role = envelope.client.role;
    if (typeof role !== 'string' || role.length === 0 || role === '*') {
      throw new Error('client.role must be a non-empty string');
    }
    const max = this.maxSeriesPerMetric;
    const allowed = allowedPersistLogs(persistLogs);
    const instanceId = envelope.client.instanceId;
    let lifetimeChanged = false;
    let persistLogsChanged = false;
    for (const frame of envelope.frames) {
      const minute = minuteFloor(frame.from);
      let window = this.windows.get(minute);
      if (!window) {
        window = emptyWindow(minute);
        this.windows.set(minute, window);
      }
      window.frames += 1;
      window.events += frame.events.length;
      window.logs += frame.logs.length;
      let stats = window.roleStats.get(role);
      if (!stats) {
        stats = { frames: 0, events: 0, logs: 0 };
        window.roleStats.set(role, stats);
      }
      stats.frames += 1;
      stats.events += frame.events.length;
      stats.logs += frame.logs.length;
      if (ingestExperimentEvents(window, this.lifetime, frame.events, role)) lifetimeChanged = true;
      if (ingestPersistLogs(window, this.persistLogLifetime, frame.logs, role, instanceId, allowed)) {
        persistLogsChanged = true;
      }
      for (const [name, dims, value] of frame.metrics.counters) {
        const key = seriesKey(role, name, dims);
        const capKey = eventKey(role, name);
        if (!admitSeries(window.counters, window.counterSeriesByName, capKey, key, max)) {
          window.cardinalityDropped += 1;
          continue;
        }
        window.counters.set(key, {
          name,
          dims,
          role,
          value: (window.counters.get(key)?.value || 0) + value
        });
      }
      for (const row of frame.metrics.gauges) {
        const [name, dims, value, timestamp] = row;
        const key = seriesKey(role, name, dims);
        const capKey = eventKey(role, name);
        if (!admitSeries(window.gauges, window.gaugeSeriesByName, capKey, key, max)) {
          window.cardinalityDropped += 1;
          continue;
        }
        const prev = window.gauges.get(key);
        if (!prev || (timestamp || 0) >= (prev.timestamp || 0)) {
          window.gauges.set(key, { name, dims, role, value, timestamp: timestamp || 0 });
        }
      }
      for (const [name, dims, body] of frame.metrics.histograms) {
        const key = seriesKey(role, name, dims);
        const capKey = eventKey(role, name);
        if (!admitSeries(window.histograms, window.histogramSeriesByName, capKey, key, max)) {
          window.cardinalityDropped += 1;
          continue;
        }
        window.histograms.set(key, {
          name,
          dims,
          role,
          body: mergeHistogram(window.histograms.get(key)?.body, body)
        });
      }
      for (const [name, dims, body] of frame.metrics.distincts || []) {
        const key = seriesKey(role, name, dims);
        const capKey = eventKey(role, name);
        if (!admitSeries(window.distincts, window.distinctSeriesByName, capKey, key, max)) {
          window.cardinalityDropped += 1;
          continue;
        }
        const previous = window.distincts.get(key);
        window.distincts.set(key, {
          name,
          dims,
          role,
          body: previous ? mergeHllBodies(previous.body, body) : normalizeHllBody(body)
        });
      }
    }
    this._prune();
    return {
      experiments: lifetimeChanged,
      persistLogs: persistLogsChanged,
      windows: envelope.frames.length > 0
    };
  }

  _prune() {
    const cutoff = Date.now() - this.retentionMs;
    for (const [minute] of this.windows) {
      if (minute < cutoff) this.windows.delete(minute);
    }
  }

  windowsSnapshot() {
    const out = [];
    for (const window of this.windows.values()) {
      const roles = {};
      for (const [name, row] of window.roleStats) {
        roles[name] = { frames: row.frames, events: row.events, logs: row.logs };
      }
      const experiments = [];
      for (const [id, byVariant] of window.experiments) {
        const variants = [];
        for (const [key, stats] of byVariant) {
          variants.push({
            key,
            exposures: stats.exposures,
            goals: stats.goals,
            goalSum: stats.goalSum,
            goalSumSq: stats.goalSumSq
          });
        }
        experiments.push({ id, variants });
      }
      out.push({
        from: window.from,
        to: window.to,
        frames: window.frames,
        events: window.events,
        logs: window.logs,
        cardinalityDropped: window.cardinalityDropped,
        roles,
        counters: [...window.counters.values()].map((row) => ({
          name: row.name,
          dims: cloneDims(row.dims),
          role: row.role,
          value: row.value
        })),
        gauges: [...window.gauges.values()].map((row) => ({
          name: row.name,
          dims: cloneDims(row.dims),
          role: row.role,
          value: row.value,
          timestamp: row.timestamp
        })),
        histograms: [...window.histograms.values()].map((row) => ({
          name: row.name,
          dims: cloneDims(row.dims),
          role: row.role,
          body: cloneHistogramBody(row.body)
        })),
        distincts: [...window.distincts.values()].map((row) => ({
          name: row.name,
          dims: cloneDims(row.dims),
          role: row.role,
          body: normalizeHllBody(row.body)
        })),
        eventNames: [...window.eventNames.values()].map((row) => ({
          name: row.name,
          role: row.role,
          count: row.count
        })),
        logNames: [...window.logNames.values()].map((row) => durableLogRow(row)),
        experiments
      });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  replaceWindows(windows) {
    this.windows = new Map();
    if (windows === undefined || windows === null) {
      return;
    }
    if (!Array.isArray(windows)) throw new Error('aggregate windows must be an array');
    for (const incoming of windows) {
      const window = emptyWindow(incoming.from);
      window.to = incoming.to;
      window.frames = incoming.frames;
      window.events = incoming.events;
      window.logs = incoming.logs;
      window.cardinalityDropped = incoming.cardinalityDropped;
      for (const [name, row] of Object.entries(incoming.roles)) {
        window.roleStats.set(name, { frames: row.frames, events: row.events, logs: row.logs });
      }
      for (const row of incoming.counters) {
        const dims = cloneDims(row.dims);
        const key = seriesKey(row.role, row.name, dims);
        putSeries(window.counters, window.counterSeriesByName, key, eventKey(row.role, row.name), {
          name: row.name,
          dims,
          role: row.role,
          value: row.value
        });
      }
      for (const row of incoming.gauges) {
        const dims = cloneDims(row.dims);
        const key = seriesKey(row.role, row.name, dims);
        putSeries(window.gauges, window.gaugeSeriesByName, key, eventKey(row.role, row.name), {
          name: row.name,
          dims,
          role: row.role,
          value: row.value,
          timestamp: row.timestamp
        });
      }
      for (const row of incoming.histograms) {
        const dims = cloneDims(row.dims);
        const key = seriesKey(row.role, row.name, dims);
        putSeries(window.histograms, window.histogramSeriesByName, key, eventKey(row.role, row.name), {
          name: row.name,
          dims,
          role: row.role,
          body: cloneHistogramBody(row.body)
        });
      }
      for (const row of incoming.distincts || []) {
        const dims = cloneDims(row.dims);
        const key = seriesKey(row.role, row.name, dims);
        putSeries(window.distincts, window.distinctSeriesByName, key, eventKey(row.role, row.name), {
          name: row.name,
          dims,
          role: row.role,
          body: normalizeHllBody(row.body)
        });
      }
      for (const row of incoming.eventNames) {
        window.eventNames.set(eventKey(row.role, row.name), {
          name: row.name,
          role: row.role,
          count: row.count
        });
      }
      for (const row of incoming.logNames) {
        const exemplar = copyLogExemplar(row.exemplar);
        const stored = { name: row.name, level: row.level, role: row.role, count: row.count };
        if (exemplar) stored.exemplar = exemplar;
        window.logNames.set(persistLogKey(row.role, row.level, row.name), stored);
      }
      for (const experiment of incoming.experiments) {
        const byVariant = new Map();
        for (const variant of experiment.variants) {
          byVariant.set(variant.key, {
            exposures: variant.exposures,
            goals: variant.goals,
            goalSum: variant.goalSum,
            goalSumSq: variant.goalSumSq
          });
        }
        window.experiments.set(experiment.id, byVariant);
      }
      this.windows.set(incoming.from, window);
    }
    this._prune();
  }

  snapshot(filter = {}) {
    const names = nameSet(filter.names);
    const role = filter.role;
    const from = filter.from;
    const to = filter.to;
    const out = [];
    for (const window of this.windows.values()) {
      if (typeof from === 'number' && window.to <= from) continue;
      if (typeof to === 'number' && window.from >= to) continue;
      const eventNames = [];
      for (const row of window.eventNames.values()) {
        if (names && !names.has(row.name)) continue;
        if (role && row.role !== role) continue;
        eventNames.push({ name: row.name, role: row.role, count: row.count });
      }
      const logNames = [];
      for (const row of window.logNames.values()) {
        if (names && !names.has(row.name)) continue;
        if (role && row.role !== role) continue;
        logNames.push(serializePersistLog(row));
      }
      const stats = {};
      for (const [name, row] of window.roleStats) {
        stats[name] = { frames: row.frames, events: row.events, logs: row.logs };
      }
      const roleRow = role ? window.roleStats.get(role) : null;
      out.push({
        from: window.from,
        to: window.to,
        frames: roleRow ? roleRow.frames : window.frames,
        events: roleRow ? roleRow.events : window.events,
        logs: roleRow ? roleRow.logs : window.logs,
        roles: stats,
        counters: filterByRole(filterByName([...window.counters.values()], names), role),
        gauges: filterByRole(filterByName([...window.gauges.values()], names), role),
        histograms: filterByRole(filterByName([...window.histograms.values()], names), role),
        distincts: filterByRole(filterByName([...window.distincts.values()], names), role).map((row) => ({
          name: row.name,
          dims: row.dims,
          role: row.role,
          estimate: estimateHllBody(row.body),
          precision: row.body.precision
        })),
        eventNames,
        logNames,
        experiments: serializeExperiments(window.experiments, names),
        cardinalityDropped: window.cardinalityDropped
      });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  experimentStats(experimentId) {
    const byVariant = this.lifetime.get(experimentId);
    if (!byVariant) return [];
    const out = [];
    for (const [key, stats] of byVariant) {
      out.push(
        withDerived({
          key,
          exposures: stats.exposures,
          goals: stats.goals,
          goalSum: stats.goalSum,
          goalSumSq: stats.goalSumSq
        })
      );
    }
    return out;
  }

  counterTotal(name) {
    let total = 0;
    for (const window of this.windows.values()) {
      for (const row of window.counters.values()) {
        if (row.name === name) total += row.value;
      }
    }
    return total;
  }

  overviewRows() {
    return {
      counters: this._counterTotals(),
      events: this._eventTotals(),
      histograms: this._histogramTotals(),
      logs: [...this.persistLogLifetime.values()].map(serializePersistLog)
    };
  }

  topCounters(limit) {
    return rankOutcomes(this._counterTotals(), 'counter', limit);
  }

  topEventNames(limit) {
    return rankOutcomes(this._eventTotals(), 'event', limit);
  }

  topHistograms(limit) {
    return rankOutcomes(this._histogramTotals(), 'histogram', limit);
  }

  _counterTotals() {
    const totals = new Map();
    for (const window of this.windows.values()) {
      for (const [key, row] of window.counters) {
        const prev = totals.get(key);
        if (!prev) {
          totals.set(key, { name: row.name, dims: row.dims, role: row.role, value: row.value });
        } else {
          prev.value += row.value;
        }
      }
    }
    return [...totals.values()];
  }

  _eventTotals() {
    const totals = new Map();
    for (const window of this.windows.values()) {
      for (const [key, row] of window.eventNames) {
        const prev = totals.get(key);
        if (!prev) totals.set(key, { name: row.name, role: row.role, count: row.count });
        else prev.count += row.count;
      }
    }
    return [...totals.values()];
  }

  topPersistLogs(limit) {
    return rankOutcomes([...this.persistLogLifetime.values()].map(serializePersistLog), 'log', limit);
  }

  _histogramTotals() {
    const totals = new Map();
    for (const window of this.windows.values()) {
      for (const [key, row] of window.histograms) {
        const incoming = row.body;
        const prev = totals.get(key);
        if (!prev) {
          const peak = {
            name: row.name,
            dims: row.dims,
            role: row.role,
            count: incoming.count,
            sum: incoming.sum,
            min: incoming.min,
            max: incoming.max
          };
          const exemplar = copyExemplar(incoming.exemplar);
          if (exemplar) peak.exemplar = exemplar;
          totals.set(key, peak);
          continue;
        }
        prev.count += incoming.count;
        prev.sum += incoming.sum;
        if (incoming.min < prev.min) prev.min = incoming.min;
        if (incoming.max > prev.max) {
          prev.max = incoming.max;
          applyExemplar(prev, incoming);
        } else if (incoming.max === prev.max) {
          const exemplar = copyExemplar(incoming.exemplar);
          if (exemplar) prev.exemplar = exemplar;
        }
      }
    }
    return [...totals.values()];
  }
}
