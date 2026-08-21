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

function experimentSlot(window, experimentId, variantKey) {
  let byVariant = window.experiments.get(experimentId);
  if (!byVariant) {
    byVariant = new Map();
    window.experiments.set(experimentId, byVariant);
  }
  let row = byVariant.get(variantKey);
  if (!row) {
    row = { exposures: 0, goals: 0, goalSum: 0 };
    byVariant.set(variantKey, row);
  }
  return row;
}

function ingestExperimentEvents(window, events, role) {
  for (const row of events) {
    const name = row[1];
    const key = eventKey(role, name);
    const prev = window.eventNames.get(key);
    if (!prev) window.eventNames.set(key, { name, role, count: 1 });
    else prev.count += 1;
    const attrs = row[2] && typeof row[2] === 'object' ? row[2] : {};
    if (name === 'experiment.exposure') {
      if (typeof attrs.experiment === 'string' && typeof attrs.variant === 'string') {
        experimentSlot(window, attrs.experiment, attrs.variant).exposures += 1;
      }
      continue;
    }
    if (name !== 'experiment.goal') continue;
    const assignments = Array.isArray(attrs.experiments) ? attrs.experiments : [];
    const value = typeof attrs.value === 'number' && Number.isFinite(attrs.value) ? attrs.value : 1;
    for (const item of assignments) {
      if (!item || typeof item.experiment !== 'string' || typeof item.variant !== 'string') continue;
      const slot = experimentSlot(window, item.experiment, item.variant);
      slot.goals += 1;
      slot.goalSum += value;
    }
  }
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

function serializeExperiments(map, names) {
  const out = [];
  for (const [id, byVariant] of map) {
    if (names && !names.has(id)) continue;
    const variants = [];
    for (const [key, stats] of byVariant) {
      variants.push({ key, exposures: stats.exposures, goals: stats.goals, goalSum: stats.goalSum });
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
    counterSeriesByName: new Map(),
    gaugeSeriesByName: new Map(),
    histogramSeriesByName: new Map(),
    eventNames: new Map(),
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
  }

  ingest(envelope) {
    const role = envelope.client.role;
    if (typeof role !== 'string' || role.length === 0 || role === '*') {
      throw new Error('client.role must be a non-empty string');
    }
    const max = this.maxSeriesPerMetric;
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
      ingestExperimentEvents(window, frame.events, role);
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
    }
    this._prune();
  }

  _prune() {
    const cutoff = Date.now() - this.retentionMs;
    for (const [minute] of this.windows) {
      if (minute < cutoff) this.windows.delete(minute);
    }
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
        eventNames,
        experiments: serializeExperiments(window.experiments, names),
        cardinalityDropped: window.cardinalityDropped
      });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  experimentStats(experimentId) {
    const variants = new Map();
    for (const window of this.windows.values()) {
      const byVariant = window.experiments.get(experimentId);
      if (!byVariant) continue;
      for (const [key, stats] of byVariant) {
        const row = variants.get(key) || { key, exposures: 0, goals: 0, goalSum: 0 };
        row.exposures += stats.exposures;
        row.goals += stats.goals;
        row.goalSum += stats.goalSum;
        variants.set(key, row);
      }
    }
    return [...variants.values()];
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

  topCounters(limit) {
    const totals = new Map();
    for (const window of this.windows.values()) {
      for (const row of window.counters.values()) {
        const key = seriesKey(row.role, row.name, row.dims);
        const prev = totals.get(key);
        if (!prev) {
          totals.set(key, { name: row.name, dims: row.dims, role: row.role, value: row.value });
        } else {
          prev.value += row.value;
        }
      }
    }
    const ranked = [...totals.values()].sort((a, b) => b.value - a.value);
    if (limit === undefined || limit === null) return ranked;
    return ranked.slice(0, limit);
  }

  topEventNames(limit) {
    const totals = new Map();
    for (const window of this.windows.values()) {
      for (const row of window.eventNames.values()) {
        const key = eventKey(row.role, row.name);
        const prev = totals.get(key);
        if (!prev) totals.set(key, { name: row.name, role: row.role, count: row.count });
        else prev.count += row.count;
      }
    }
    const ranked = [...totals.values()].sort((a, b) => b.count - a.count);
    if (limit === undefined || limit === null) return ranked;
    return ranked.slice(0, limit);
  }
}
