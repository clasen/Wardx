import { validateDimensions } from './dimensions.js';

export class Histogram {
  constructor(name, dims, bounds, limits) {
    this.name = name;
    this.dims = dims;
    this.bounds = bounds;
    this.maxDimensionKeys = limits ? limits.maxDimensionKeys : null;
    this.maxDimensionValueLength = limits ? limits.maxDimensionValueLength : null;
    this.counts = new Array(bounds.length).fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.exemplar = null;
  }

  observe(value, attrs) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('histogram.observe requires a finite number');
    }
    const isMax = value >= this.max;
    this.count += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (isMax) {
      this.max = value;
      this.exemplar = this._exemplarFrom(value, attrs);
    }
    const bounds = this.bounds;
    const counts = this.counts;
    for (let i = 0; i < bounds.length; i++) {
      if (value <= bounds[i]) {
        counts[i] += 1;
        return;
      }
    }
  }

  _exemplarFrom(value, attrs) {
    if (attrs == null) return null;
    if (
      !Number.isInteger(this.maxDimensionKeys) ||
      !Number.isInteger(this.maxDimensionValueLength)
    ) {
      throw new Error('histogram.observe attrs require dimension limits');
    }
    const checked = validateDimensions(
      attrs,
      this.maxDimensionKeys,
      this.maxDimensionValueLength
    );
    if (!checked.ok || checked.dims == null) return null;
    return { value, attrs: { ...checked.dims } };
  }

  snapshot() {
    const buckets = new Array(this.bounds.length);
    for (let i = 0; i < this.bounds.length; i++) {
      buckets[i] = [this.bounds[i], this.counts[i]];
    }
    const body = {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      buckets
    };
    if (this.exemplar) body.exemplar = this.exemplar;
    return body;
  }

  reset() {
    this.counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.exemplar = null;
  }
}

export const NOOP_HISTOGRAM = {
  observe() {}
};
