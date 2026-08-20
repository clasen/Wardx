export class Counter {
  constructor(name, dims) {
    this.name = name;
    this.dims = dims;
    this.value = 0;
  }

  inc() {
    this.value += 1;
  }

  add(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error('counter.add requires a finite number');
    }
    this.value += n;
  }
}

export const NOOP_COUNTER = {
  inc() {},
  add() {}
};
