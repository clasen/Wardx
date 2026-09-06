export class OperationalHealth {
  constructor({ config, stateStore, persistence, syncGate, mcpReady }) {
    this.config = config;
    this.stateStore = stateStore;
    this.persistence = persistence;
    this.syncGate = syncGate;
    this.mcpReady = mcpReady;
    this.stopping = false;
    this.sqliteReady = false;
    this.probe();
    this.timer = setInterval(() => this.probe(), config.probeIntervalMs);
    this.timer.unref();
  }

  probe() {
    if (this.stopping) return;
    try {
      this.stateStore.probeWritable(this.config.probeTimeoutMs);
      this.sqliteReady = true;
    } catch {
      this.sqliteReady = false;
    }
  }

  snapshot() {
    const persistence = this.persistence.readiness(Date.now());
    const capacity = this.syncGate.snapshot();
    const checks = {
      running: !this.stopping,
      sqlite: this.sqliteReady,
      persistence: persistence.healthy && persistence.lagMs < this.config.maxPersistenceLagMs,
      capacity: persistence.withinCapacity && capacity.active < capacity.limit,
      mcp: this.mcpReady()
    };
    return { ok: Object.values(checks).every(Boolean), checks };
  }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
  }
}
