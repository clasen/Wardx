export class Histogram {
  constructor(name, dims, bounds) {
    this.name = name;
    this.dims = dims;
    this.bounds = bounds;
    this.counts = new Array(bounds.length).fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  observe(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('histogram.observe requires a finite number');
    }
    this.count += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    const bounds = this.bounds;
    const counts = this.counts;
    for (let i = 0; i < bounds.length; i++) {
      if (value <= bounds[i]) {
        counts[i] += 1;
        return;
      }
    }
  }

  snapshot() {
    const buckets = new Array(this.bounds.length);
    for (let i = 0; i < this.bounds.length; i++) {
      buckets[i] = [this.bounds[i], this.counts[i]];
    }
    return {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      buckets
    };
  }

  reset() {
    this.counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }
}

export const NOOP_HISTOGRAM = {
  observe() {}
};
