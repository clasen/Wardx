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

function seriesKey(name, dims) {
  return name + '\0' + dimKey(dims);
}

function minuteFloor(ts) {
  return Math.floor(ts / 60000) * 60000;
}

function mergeHistogram(existing, incoming) {
  if (!existing) {
    return {
      count: incoming.count,
      sum: incoming.sum,
      min: incoming.min,
      max: incoming.max,
      buckets: incoming.buckets.map((pair) => [pair[0], pair[1]])
    };
  }
  existing.count += incoming.count;
  existing.sum += incoming.sum;
  if (incoming.min < existing.min) existing.min = incoming.min;
  if (incoming.max > existing.max) existing.max = incoming.max;
  const byBound = new Map(existing.buckets);
  for (const [bound, count] of incoming.buckets) {
    byBound.set(bound, (byBound.get(bound) || 0) + count);
  }
  existing.buckets = [...byBound.entries()].sort((a, b) => a[0] - b[0]);
  return existing;
}

export class FrameAggregator {
  constructor({ aggregateRetentionMinutes }) {
    this.retentionMs = aggregateRetentionMinutes * 60000;
    this.windows = new Map();
  }

  ingest(envelope) {
    for (const frame of envelope.frames) {
      const minute = minuteFloor(frame.from);
      let window = this.windows.get(minute);
      if (!window) {
        window = {
          from: minute,
          to: minute + 60000,
          counters: new Map(),
          gauges: new Map(),
          histograms: new Map(),
          events: 0,
          logs: 0,
          frames: 0
        };
        this.windows.set(minute, window);
      }
      window.frames += 1;
      window.events += frame.events.length;
      window.logs += frame.logs.length;
      for (const [name, dims, value] of frame.metrics.counters) {
        const key = seriesKey(name, dims);
        window.counters.set(key, {
          name,
          dims,
          value: (window.counters.get(key)?.value || 0) + value
        });
      }
      for (const row of frame.metrics.gauges) {
        const [name, dims, value, timestamp] = row;
        const key = seriesKey(name, dims);
        const prev = window.gauges.get(key);
        if (!prev || (timestamp || 0) >= (prev.timestamp || 0)) {
          window.gauges.set(key, { name, dims, value, timestamp: timestamp || 0 });
        }
      }
      for (const [name, dims, body] of frame.metrics.histograms) {
        const key = seriesKey(name, dims);
        window.histograms.set(key, {
          name,
          dims,
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

  snapshot() {
    const out = [];
    for (const window of this.windows.values()) {
      out.push({
        from: window.from,
        to: window.to,
        frames: window.frames,
        events: window.events,
        logs: window.logs,
        counters: [...window.counters.values()],
        gauges: [...window.gauges.values()],
        histograms: [...window.histograms.values()]
      });
    }
    return out.sort((a, b) => a.from - b.from);
  }
}
