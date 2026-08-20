import { Counter, NOOP_COUNTER } from './Counter.js';
import { Gauge, NOOP_GAUGE } from './Gauge.js';
import { Histogram, NOOP_HISTOGRAM } from './Histogram.js';
import { startTimer } from './Timer.js';
import { assertMetricName, dimKey, validateDimensions } from './dimensions.js';

function boundsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function parseHistogramArgs(a, b, defaultBuckets) {
  let buckets = defaultBuckets;
  let dims = null;
  if (a != null) {
    if (Object.prototype.hasOwnProperty.call(a, 'buckets')) {
      buckets = a.buckets;
      const rest = { ...a };
      delete rest.buckets;
      dims = Object.keys(rest).length > 0 ? rest : null;
      if (b != null) dims = dims ? { ...dims, ...b } : b;
    } else {
      dims = a;
      if (b != null && Object.prototype.hasOwnProperty.call(b, 'buckets')) {
        buckets = b.buckets;
      }
    }
  }
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error('histogram buckets must be a non-empty array');
  }
  let prev = -Infinity;
  for (const bound of buckets) {
    if (typeof bound !== 'number' || !Number.isFinite(bound) || bound <= prev) {
      throw new Error('histogram buckets must be strictly increasing finite numbers');
    }
    prev = bound;
  }
  return { buckets, dims };
}

export class MetricsRegistry {
  constructor(options) {
    this.maxSeriesPerMetric = options.maxSeriesPerMetric;
    this.maxDimensionKeys = options.maxDimensionKeys;
    this.maxDimensionValueLength = options.maxDimensionValueLength;
    this.defaultHistogramBuckets = options.defaultHistogramBuckets;
    this.onCardinalityDropped = options.onCardinalityDropped;
    this.countersByName = new Map();
    this.gaugesByName = new Map();
    this.histogramsByName = new Map();
    this.rejected = new Set();
  }

  _series(kindMap, Ctor, name, dims, extra) {
    assertMetricName(name);
    const kindPrefix = kindMap === this.histogramsByName ? 'h' : kindMap === this.gaugesByName ? 'g' : 'c';
    const checked = validateDimensions(dims, this.maxDimensionKeys, this.maxDimensionValueLength);
    const key = dimKey(checked.ok ? checked.dims : dims);
    const rejectKey = kindPrefix + '\0' + name + '\0' + key;
    if (this.rejected.has(rejectKey)) return null;
    if (!checked.ok) {
      this.rejected.add(rejectKey);
      this.onCardinalityDropped();
      return null;
    }
    let byKey = kindMap.get(name);
    if (!byKey) {
      byKey = new Map();
      kindMap.set(name, byKey);
    }
    let series = byKey.get(key);
    if (series) return series;
    if (byKey.size >= this.maxSeriesPerMetric) {
      this.rejected.add(rejectKey);
      this.onCardinalityDropped();
      return null;
    }
    series = extra ? extra(checked.dims) : new Ctor(name, checked.dims);
    byKey.set(key, series);
    return series;
  }

  counter(name, dims) {
    const series = this._series(this.countersByName, Counter, name, dims);
    return series || NOOP_COUNTER;
  }

  gauge(name, dims) {
    const series = this._series(this.gaugesByName, Gauge, name, dims);
    return series || NOOP_GAUGE;
  }

  histogram(name, a, b) {
    const { buckets, dims } = parseHistogramArgs(a, b, this.defaultHistogramBuckets);
    const series = this._series(this.histogramsByName, Histogram, name, dims, (resolvedDims) => {
      return new Histogram(name, resolvedDims, buckets);
    });
    if (!series) return NOOP_HISTOGRAM;
    if (!boundsEqual(series.bounds, buckets)) {
      throw new Error(`histogram ${name} buckets cannot change for an existing series`);
    }
    return series;
  }

  timer(name, dims) {
    const histogram = this.histogram(name, dims);
    return startTimer((duration, endDims) => {
      if (endDims) {
        this.histogram(name, { ...(dims || {}), ...endDims }).observe(duration);
        return;
      }
      histogram.observe(duration);
    });
  }

  snapshotAndReset() {
    const counters = [];
    for (const byKey of this.countersByName.values()) {
      for (const series of byKey.values()) {
        if (series.value !== 0) {
          counters.push([series.name, series.dims, series.value]);
          series.value = 0;
        }
      }
    }
    const gauges = [];
    for (const byKey of this.gaugesByName.values()) {
      for (const series of byKey.values()) {
        if (series.dirty) {
          gauges.push([series.name, series.dims, series.value, series.timestamp]);
          series.dirty = false;
        }
      }
    }
    const histograms = [];
    for (const byKey of this.histogramsByName.values()) {
      for (const series of byKey.values()) {
        if (series.count > 0) {
          histograms.push([series.name, series.dims, series.snapshot()]);
          series.reset();
        }
      }
    }
    return { counters, gauges, histograms };
  }

  isDirty() {
    for (const byKey of this.countersByName.values()) {
      for (const series of byKey.values()) {
        if (series.value !== 0) return true;
      }
    }
    for (const byKey of this.gaugesByName.values()) {
      for (const series of byKey.values()) {
        if (series.dirty) return true;
      }
    }
    for (const byKey of this.histogramsByName.values()) {
      for (const series of byKey.values()) {
        if (series.count > 0) return true;
      }
    }
    return false;
  }
}
