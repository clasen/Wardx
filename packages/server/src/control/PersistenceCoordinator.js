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
import { HistoricalCompactor, utcBucketStart } from '../aggregation/history/index.js';

const KINDS = new Set(['aggregateWindows', 'experimentStats', 'logStats', 'history']);

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
  constructor({ config, registry, diagnostics, stateStore, writeAtomic = writeJsonAtomic }) {
    this.config = config;
    this.registry = registry;
    this.diagnostics = diagnostics;
    this.writeAtomic = writeAtomic;
    this.stateStore = stateStore;
    this.compactor = stateStore ? new HistoricalCompactor(stateStore) : null;
    this.dirtyKinds = new Set();
    this.timer = null;
    this.inFlight = null;
    this.metrics = {
      writes: 0,
      writeFailures: 0,
      writeLatencyTotalMs: 0,
      writeLatencyMaxMs: 0,
      historyCompactions: 0,
      historyRowsPruned: 0
    };
    this.compactionTimer = stateStore
      ? setInterval(() => this.mark('history'), config.history.compactionIntervalMs)
      : null;
    this.compactionTimer?.unref?.();
    if (stateStore) this.mark('history');
  }

  mark(kind) {
    if (!KINDS.has(kind)) throw new Error(`unknown persistence kind: ${kind}`);
    if (kind !== 'history' && !this.config.configPath) return;
    this.dirtyKinds.add(kind);
    this._schedule();
  }

  canAcceptHistory(history, prepared) {
    const pending = history.projectedPending(prepared);
    return {
      accepted:
        pending.batches <= this.config.sqlite.maxPendingBatches &&
        pending.bytes <= this.config.sqlite.maxPendingBytes,
      ...pending,
      maxBatches: this.config.sqlite.maxPendingBatches,
      maxBytes: this.config.sqlite.maxPendingBytes
    };
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {
        this._schedule();
      });
    }, this.config.persistenceFlushIntervalMs);
    this.timer.unref?.();
  }

  async flush() {
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
    if (kind === 'history') {
      await this._writeHistory();
      return;
    }
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

  async _writeHistory() {
    if (!this.stateStore) throw new Error('SQLite state store is required for historical persistence');
    const started = process.hrtime.bigint();
    const now = Date.now();
    for (const project of this.registry.names()) {
      const history = this.registry.get(project).history;
      const pending = history.pending(now);
      for (let index = 0; index < pending.length; index += this.config.sqlite.maxWriteBatchRows) {
        this.stateStore.saveBuckets('minute', pending.slice(index, index + this.config.sqlite.maxWriteBatchRows));
      }
      history.acknowledge(pending);
      this.stateStore.finalizeBucketsThrough(
        project,
        'minute',
        now - this.config.history.clockSkewAllowanceMs
      );
      this._scanCompaction(project, 'minute', 'hour', now);
      this._scanCompaction(project, 'hour', 'day', now);
      this._pruneHistory(project, now);
    }
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    this.metrics.writes += 1;
    this.metrics.writeLatencyTotalMs += latencyMs;
    if (latencyMs > this.metrics.writeLatencyMaxMs) this.metrics.writeLatencyMaxMs = latencyMs;
  }

  _scanCompaction(project, sourceTier, destinationTier, now) {
    const destinationWidth = destinationTier === 'hour' ? 3_600_000 : 86_400_000;
    let afterFrom = -1;
    let lastDestinationFrom = null;
    while (true) {
      const starts = this.stateStore.listBucketStarts({
        project,
        tier: sourceTier,
        afterFrom,
        limit: this.config.sqlite.maxWriteBatchRows
      });
      if (starts.length === 0) return;
      for (const sourceFrom of starts) {
        const destinationFrom = utcBucketStart(sourceFrom, destinationTier);
        if (destinationFrom === lastDestinationFrom) continue;
        lastDestinationFrom = destinationFrom;
        const source = this.stateStore.readBuckets({
          project,
          tier: sourceTier,
          from: destinationFrom,
          to: destinationFrom + destinationWidth
        });
        if (source.length === 0 || source.some((bucket) => !bucket.finalized)) continue;
        this.compactor.compact({
          project,
          sourceTier,
          destinationTier,
          destinationFrom,
          finalized: now >= destinationFrom + destinationWidth + this.config.history.maxAcceptedPastAgeMs
        });
        this.metrics.historyCompactions += 1;
      }
      afterFrom = starts.at(-1);
      if (starts.length < this.config.sqlite.maxWriteBatchRows) return;
    }
  }

  _pruneHistory(project, now) {
    const cutoffs = {
      minute: now - this.config.aggregateRetentionMinutes * 60_000,
      hour: now - this.config.history.aggregateHourlyRetentionHours * 3_600_000,
      day: now - this.config.history.aggregateDailyRetentionDays * 86_400_000
    };
    for (const tier of ['minute', 'hour', 'day']) {
      this.metrics.historyRowsPruned += this.stateStore.pruneBuckets(project, tier, cutoffs[tier]);
    }
  }

  async close() {
    if (this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
    if (this.stateStore) this.mark('history');
    await this.flush();
  }

  snapshotMetrics() {
    let pendingBatches = 0;
    let pendingBytes = 0;
    if (this.stateStore) {
      for (const project of this.registry.names()) {
        const pending = this.registry.get(project).history.projectedPending({ updates: [] });
        pendingBatches += pending.batches;
        pendingBytes += pending.bytes;
      }
    }
    return {
      writes: this.metrics.writes,
      writeFailures: this.metrics.writeFailures,
      writeLatencyMs: {
        total: this.metrics.writeLatencyTotalMs,
        max: this.metrics.writeLatencyMaxMs
      },
      historyCompactions: this.metrics.historyCompactions,
      historyRowsPruned: this.metrics.historyRowsPruned,
      pendingBatches,
      pendingBytes,
      sqlite: this.stateStore?.snapshotMetrics() || null,
      dirty: this.dirtyKinds.size > 0,
      inFlight: this.inFlight !== null
    };
  }
}
