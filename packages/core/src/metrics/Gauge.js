export class Gauge {
  constructor(name, dims) {
    this.name = name;
    this.dims = dims;
    this.value = 0;
    this.timestamp = 0;
    this.dirty = false;
  }

  set(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('gauge.set requires a finite number');
    }
    this.value = value;
    this.timestamp = Date.now();
    this.dirty = true;
  }
}

export const NOOP_GAUGE = {
  set() {}
};
