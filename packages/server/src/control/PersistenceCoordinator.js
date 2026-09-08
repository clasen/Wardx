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

const KINDS = new Set(['aggregateWindows', 'experimentStats', 'logStats', 'history', 'sqliteMaintenance']);

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
    this.compactionCandidates = new Map();
    this.dirtySince = null;
    this.writeHealthy = true;
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
      ? setInterval(() => {
          this.mark('history');
          this.mark('sqliteMaintenance');
        }, config.history.compactionIntervalMs)
      : null;
    this.compactionTimer?.unref?.();
    if (stateStore) this.mark('history');
  }

  mark(kind) {
    if (!KINDS.has(kind)) throw new Error(`unknown persistence kind: ${kind}`);
    if (kind !== 'history' && kind !== 'sqliteMaintenance' && !this.config.configPath) return;
    if (this.dirtySince === null) this.dirtySince = Date.now();
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
        this.writeHealthy = false;
        for (const kind of batch) this.dirtyKinds.add(kind);
        this.metrics.writeFailures += 1;
        this.diagnostics.report('persistence.flush_failed', error);
        throw error;
      }
    }
    this.dirtySince = null;
    this.writeHealthy = true;
  }

  async _write(kind) {
    if (kind === 'sqliteMaintenance') {
      this.stateStore.optimize();
      return;
    }
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
      for (const bucket of pending) {
        this._scheduleCompaction(project, 'minute', 'hour', bucket.from);
      }
      history.acknowledge(pending);
      history.prunePersisted(now - this.config.history.maxAcceptedPastAgeMs);
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

  _candidates(project, sourceTier, destinationTier) {
    const key = `${project}\0${sourceTier}`;
    if (!this.compactionCandidates.has(key)) {
      const candidates = new Map();
      for (const from of this.stateStore.compactionStarts(project, sourceTier, destinationTier)) {
        candidates.set(from, 0);
      }
      this.compactionCandidates.set(key, candidates);
    }
    return this.compactionCandidates.get(key);
  }

  _scheduleCompaction(project, sourceTier, destinationTier, sourceFrom) {
    this._candidates(project, sourceTier, destinationTier)
      .set(utcBucketStart(sourceFrom, destinationTier), 0);
  }

  _scanCompaction(project, sourceTier, destinationTier, now) {
    const destinationWidth = destinationTier === 'hour' ? 3_600_000 : 86_400_000;
    const candidates = this._candidates(project, sourceTier, destinationTier);
    for (const [destinationFrom, nextAt] of candidates) {
      if (now < nextAt) continue;
      const source = this.stateStore.readBuckets({
        project,
        tier: sourceTier,
        from: destinationFrom,
        to: destinationFrom + destinationWidth
      });
      if (source.length === 0) {
        candidates.delete(destinationFrom);
        continue;
      }
      const open = source.filter((bucket) => !bucket.finalized);
      if (open.length > 0) {
        const allowance = sourceTier === 'minute'
          ? this.config.history.clockSkewAllowanceMs
          : this.config.history.maxAcceptedPastAgeMs;
        candidates.set(destinationFrom, Math.max(...open.map((bucket) => bucket.to + allowance)));
        continue;
      }
      const finalizesAt = destinationFrom + destinationWidth + this.config.history.maxAcceptedPastAgeMs;
      const finalized = now >= finalizesAt;
      this.compactor.compact({
        project, sourceTier, destinationTier, destinationFrom, finalized, sourceBuckets: source
      });
      if (destinationTier === 'hour') this._scheduleCompaction(project, 'hour', 'day', destinationFrom);
      if (finalized) candidates.delete(destinationFrom);
      else candidates.set(destinationFrom, finalizesAt);
      this.metrics.historyCompactions += 1;
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

  readiness(now) {
    let withinCapacity = true;
    if (this.stateStore) {
      for (const project of this.registry.names()) {
        const pending = this.registry.get(project).history.projectedPending({ updates: [] });
        if (pending.batches >= this.config.sqlite.maxPendingBatches || pending.bytes >= this.config.sqlite.maxPendingBytes) {
          withinCapacity = false;
        }
      }
    }
    return {
      healthy: this.writeHealthy,
      lagMs: this.dirtySince === null ? 0 : Math.max(0, now - this.dirtySince),
      withinCapacity
    };
  }
}
