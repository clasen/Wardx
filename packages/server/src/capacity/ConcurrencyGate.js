export class ConcurrencyGate {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be an integer >= 1');
    this.limit = limit;
    this.active = 0;
    this.rejected = 0;
    this.peak = 0;
  }

  enter() {
    if (this.active >= this.limit) {
      this.rejected += 1;
      return null;
    }
    this.active += 1;
    if (this.active > this.peak) this.peak = this.active;
    let left = false;
    return () => {
      if (left) throw new Error('concurrency lease already released');
      left = true;
      this.active -= 1;
    };
  }

  snapshot() {
    return { limit: this.limit, active: this.active, peak: this.peak, rejected: this.rejected };
  }
}

export class QueuedConcurrencyGate {
  constructor(limit, maxPending) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be an integer >= 1');
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('pending concurrency limit must be an integer >= 1');
    }
    this.limit = limit;
    this.maxPending = maxPending;
    this.active = 0;
    this.pending = [];
    this.peakActive = 0;
    this.peakPending = 0;
    this.rejected = 0;
  }

  acquire() {
    if (this.active < this.limit) return Promise.resolve(this._lease());
    if (this.pending.length >= this.maxPending) {
      this.rejected += 1;
      return Promise.reject(new Error('MCP read overloaded'));
    }
    return new Promise((resolve) => {
      this.pending.push(resolve);
      if (this.pending.length > this.peakPending) this.peakPending = this.pending.length;
    });
  }

  _lease() {
    this.active += 1;
    if (this.active > this.peakActive) this.peakActive = this.active;
    let released = false;
    return () => {
      if (released) throw new Error('concurrency lease already released');
      released = true;
      this.active -= 1;
      const next = this.pending.shift();
      if (next) next(this._lease());
    };
  }

  snapshot() {
    return {
      limit: this.limit,
      maxPending: this.maxPending,
      active: this.active,
      pending: this.pending.length,
      peakActive: this.peakActive,
      peakPending: this.peakPending,
      rejected: this.rejected
    };
  }
}
