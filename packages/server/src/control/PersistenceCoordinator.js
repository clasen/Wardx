import { access, rename, writeFile } from 'node:fs/promises';
import {
  aggregateWindowsPath,
  experimentStatsPath,
  logStatsPath,
  snapshotAggregateWindows,
  snapshotExperimentStats,
  snapshotLogStats,
  validateAggregateWindows,
  validateExperimentStats,
  validateLogStats
} from './persist.js';

const KINDS = new Set(['aggregateWindows', 'experimentStats', 'logStats']);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeJsonAtomic(path, value, operations = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await (operations.writeFile || writeFile)(temporary, body);
  await (operations.rename || rename)(temporary, path);
}

function emptySnapshot(snapshot) {
  return Object.values(snapshot.projects).every((value) => {
    if (Array.isArray(value)) return value.length === 0;
    return Object.keys(value).length === 0;
  });
}

export class PersistenceCoordinator {
  constructor({ config, registry, diagnostics, writeAtomic = writeJsonAtomic }) {
    this.config = config;
    this.registry = registry;
    this.diagnostics = diagnostics;
    this.writeAtomic = writeAtomic;
    this.dirtyKinds = new Set();
    this.timer = null;
    this.inFlight = null;
    this.metrics = {
      writes: 0,
      writeFailures: 0,
      writeLatencyTotalMs: 0,
      writeLatencyMaxMs: 0
    };
  }

  mark(kind) {
    if (!KINDS.has(kind)) throw new Error(`unknown persistence kind: ${kind}`);
    if (!this.config.configPath) return;
    this.dirtyKinds.add(kind);
    this._schedule();
  }

  _schedule() {
    if (this.timer || !this.config.configPath) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {
        this._schedule();
      });
    }, this.config.persistenceFlushIntervalMs);
    this.timer.unref?.();
  }

  async flush() {
    if (!this.config.configPath) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
      if (this.dirtyKinds.size > 0) return this.flush();
      return;
    }
    if (this.dirtyKinds.size === 0) return;
    this.inFlight = this._drain().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    if (this.dirtyKinds.size > 0) return this.flush();
  }

  async _drain() {
    while (this.dirtyKinds.size > 0) {
      const batch = [...this.dirtyKinds];
      this.dirtyKinds.clear();
      try {
        for (const kind of batch) await this._write(kind);
      } catch (error) {
        for (const kind of batch) this.dirtyKinds.add(kind);
        this.metrics.writeFailures += 1;
        this.diagnostics.report('persistence.flush_failed', error);
        throw error;
      }
    }
  }

  async _write(kind) {
    let path;
    let snapshot;
    if (kind === 'aggregateWindows') {
      path = aggregateWindowsPath(this.config.configPath);
      snapshot = snapshotAggregateWindows(this.registry);
      validateAggregateWindows(snapshot);
    } else if (kind === 'experimentStats') {
      path = experimentStatsPath(this.config.configPath);
      snapshot = snapshotExperimentStats(this.registry);
      validateExperimentStats(snapshot);
    } else {
      path = logStatsPath(this.config.configPath);
      snapshot = snapshotLogStats(this.registry);
      validateLogStats(snapshot);
    }
    if (emptySnapshot(snapshot) && !(await exists(path))) return;
    const started = process.hrtime.bigint();
    await this.writeAtomic(path, snapshot);
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    this.metrics.writes += 1;
    this.metrics.writeLatencyTotalMs += latencyMs;
    if (latencyMs > this.metrics.writeLatencyMaxMs) this.metrics.writeLatencyMaxMs = latencyMs;
  }

  snapshotMetrics() {
    return {
      writes: this.metrics.writes,
      writeFailures: this.metrics.writeFailures,
      writeLatencyMs: {
        total: this.metrics.writeLatencyTotalMs,
        max: this.metrics.writeLatencyMaxMs
      },
      dirty: this.dirtyKinds.size > 0,
      inFlight: this.inFlight !== null
    };
  }
}
