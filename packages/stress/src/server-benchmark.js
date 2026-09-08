import http from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gzipJson, sampleEnvelope, testServerConfig } from '../../server/test/helpers.js';
import { createIngestServer, listen, loadServerConfig } from '@wardx/server';
import { report, startEventLoopProbe } from './measure.js';

const SLICE_MS = 50;
const RETENTION_WINDOWS = 4;
const MAX_GROWING_SERIES = 1000;
const PERSISTENCE_KINDS = 3;
const MIB = 1024 * 1024;

export const SERVER_PROFILES = Object.freeze({
  raw: Object.freeze({
    id: 'raw',
    label: 'in-memory SQLite / NullSink (upper bound)',
    persistence: false
  }),
  persistence: Object.freeze({
    id: 'persistence',
    label: 'CLI-equivalent NullSink / persistence enabled / growing retention',
    persistence: true
  })
});

export const SERVER_THRESHOLDS = Object.freeze({
  smoke: Object.freeze({
    minimumRateFraction: 0.5,
    maximumErrorRate: 0,
    maximumP99Ms: 1000,
    maximumEventLoopP99Ms: 500,
    maximumRssGrowthBytes: 256 * MIB,
    maximumDiskWriteLatencyMs: 1000
  }),
  full: Object.freeze({
    minimumDurationMs: 300_000,
    minimumSyncsPerSecond: 5000,
    maximumErrorRate: 0.001,
    maximumP99Ms: 100,
    maximumEventLoopP99Ms: 50,
    maximumRssGrowthBytes: 512 * MIB,
    maximumDiskWriteLatencyMs: 250
  })
});

function postGzip(agent, port, body) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/sync',
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': body.length,
          'x-wardx-key': 'test-key'
        }
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            ns: Number(process.hrtime.bigint() - t0),
            networkError: false
          });
        });
      }
    );
    req.on('error', () => {
      resolve({
        status: 0,
        ns: Number(process.hrtime.bigint() - t0),
        networkError: true
      });
    });
    req.write(body);
    req.end();
  });
}

function shiftedEnvelope(step, baseMinute) {
  const from = baseMinute - (step % RETENTION_WINDOWS) * 60_000 + 1000;
  const envelope = sampleEnvelope({ configVersion: 12 });
  const frame = envelope.frames[0];
  frame.from = from;
  frame.to = from + 500;
  frame.metrics.counters[0][1] = { retentionStep: String(step) };
  frame.metrics.gauges[0][3] = frame.to;
  frame.events[0][0] = from + 200;
  frame.logs[0][0] = from + 300;
  return envelope;
}

function growingBodies(durationMs) {
  const steps = Math.min(MAX_GROWING_SERIES, Math.max(RETENTION_WINDOWS, Math.ceil(durationMs / SLICE_MS)));
  const baseMinute = Math.floor(Date.now() / 60_000) * 60_000;
  return Array.from({ length: steps }, (_, step) => gzipJson(shiftedEnvelope(step, baseMinute)));
}

function cpuPercent(before, after, elapsedMs) {
  const usedMicros = after.user - before.user + after.system - before.system;
  return (usedMicros / (elapsedMs * 1000)) * 100;
}

function persistenceDelta(before, after) {
  return {
    writes: after.writes - before.writes,
    writeFailures: after.writeFailures - before.writeFailures,
    writeLatencyTotalMs: after.writeLatencyMs.total - before.writeLatencyMs.total,
    writeLatencyMaxMs: after.writeLatencyMs.max,
    pendingBatches: after.pendingBatches,
    pendingBytes: after.pendingBytes,
    sqliteTransactions: after.sqlite.transactions - before.sqlite.transactions,
    sqliteTransactionFailures: after.sqlite.transactionFailures - before.sqlite.transactionFailures,
    sqliteBusyFailures: after.sqlite.busyFailures - before.sqlite.busyFailures,
    checkpoints: after.sqlite.checkpoints - before.sqlite.checkpoints,
    checkpointLatencyTotalMs: after.sqlite.checkpointLatencyMs.total - before.sqlite.checkpointLatencyMs.total,
    checkpointLatencyMaxMs: after.sqlite.checkpointLatencyMs.max,
    sqliteTransactionLatencyMaxMs: after.sqlite.transactionLatencyMs.max,
    walPendingFrames: after.sqlite.wal.pendingFrames,
    dirty: after.dirty,
    inFlight: after.inFlight
  };
}

function thresholdsFor(mode, rate, durationMs, config) {
  const base = SERVER_THRESHOLDS[mode];
  return {
    ...base,
    minimumSyncsPerSecond: mode === 'smoke' ? rate * base.minimumRateFraction : base.minimumSyncsPerSecond,
    maximumWrites: PERSISTENCE_KINDS * (Math.ceil(durationMs / config.persistenceFlushIntervalMs) + 1)
  };
}

function gateResult({
  mode,
  profile,
  durationMs,
  actualRate,
  errorRate,
  p99,
  loopStats,
  rssGrowth,
  disk,
  windows,
  series,
  featureExercises,
  burstOverloads,
  burstUnexpected,
  thresholds
}) {
  const violations = [];
  if (mode === 'full' && durationMs < thresholds.minimumDurationMs) {
    violations.push(`duration ${durationMs}ms is below full gate minimum ${thresholds.minimumDurationMs}ms`);
  }
  if (actualRate < thresholds.minimumSyncsPerSecond) {
    violations.push(`actual rate ${actualRate.toFixed(1)}/s is below ${thresholds.minimumSyncsPerSecond}/s`);
  }
  if (errorRate > thresholds.maximumErrorRate) {
    violations.push(`error rate ${errorRate.toFixed(6)} exceeds ${thresholds.maximumErrorRate}`);
  }
  if (p99 > thresholds.maximumP99Ms) {
    violations.push(`p99 ${p99.toFixed(2)}ms exceeds ${thresholds.maximumP99Ms}ms`);
  }
  if (loopStats.p99Ms > thresholds.maximumEventLoopP99Ms) {
    violations.push(`event-loop p99 ${loopStats.p99Ms.toFixed(2)}ms exceeds ${thresholds.maximumEventLoopP99Ms}ms`);
  }
  if (rssGrowth > thresholds.maximumRssGrowthBytes) {
    violations.push(`RSS growth ${rssGrowth} bytes exceeds ${thresholds.maximumRssGrowthBytes} bytes`);
  }
  if (profile.persistence) {
    if (windows < RETENTION_WINDOWS) {
      violations.push(`retained windows ${windows} is below required growing-state count ${RETENTION_WINDOWS}`);
    }
    if (series < RETENTION_WINDOWS) {
      violations.push(`retained series ${series} is below required growing-state count ${RETENTION_WINDOWS}`);
    }
    if (disk.writes < 1) violations.push('persistence profile completed without a disk write');
    if (disk.writes > thresholds.maximumWrites) {
      violations.push(`persistence writes ${disk.writes} exceeds coalesced bound ${thresholds.maximumWrites}`);
    }
    if (disk.writeFailures !== 0) violations.push(`persistence reported ${disk.writeFailures} write failure(s)`);
    if (disk.sqliteTransactionFailures !== 0) {
      violations.push(`SQLite reported ${disk.sqliteTransactionFailures} transaction failure(s)`);
    }
    if (disk.sqliteBusyFailures !== 0) violations.push(`SQLite reported ${disk.sqliteBusyFailures} busy failure(s)`);
    if (disk.pendingBatches !== 0 || disk.pendingBytes !== 0) {
      violations.push(`SQLite writer remained queued (${disk.pendingBatches} batches / ${disk.pendingBytes} bytes)`);
    }
    if (disk.checkpoints < 1) violations.push('persistence profile completed without a WAL checkpoint');
    if (featureExercises < 1) violations.push('persistence profile completed without feature exercises');
    if (burstOverloads < 1) violations.push('persistence profile did not reject an overloaded sync');
    if (burstUnexpected !== 0) violations.push(`overload probe returned ${burstUnexpected} unexpected response(s)`);
    if (disk.writeLatencyMaxMs > thresholds.maximumDiskWriteLatencyMs) {
      violations.push(
        `maximum disk write latency ${disk.writeLatencyMaxMs.toFixed(2)}ms exceeds ${thresholds.maximumDiskWriteLatencyMs}ms`
      );
    }
    if (disk.dirty || disk.inFlight) violations.push('persistence remained dirty or in flight after flush');
  }
  return violations;
}

async function benchmarkConfig(profile, directory) {
  const base = testServerConfig({ sink: 'null', port: 0 });
  if (!profile.persistence) return base;
  base.credentials['test-key'].trustedForDecisions = true;
  base.projects.demo.experiments = [{
    id: 'stress-evidence-v1',
    enabled: true,
    allocation: 1,
    salt: 'stress-evidence-v1',
    roles: ['client'],
    goalMetric: 'stress.goal',
    assignmentUnitKind: 'sync-slice',
    terminalRetentionMs: 3_600_000,
    variants: [
      { key: 'control', weight: 1, values: {} },
      { key: 'test', weight: 1, values: {} }
    ]
  }];
  const configPath = join(directory, 'wardx-server.json');
  await writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return loadServerConfig(configPath);
}

function evidenceBody(step) {
  const envelope = sampleEnvelope({ configVersion: 12 });
  const timestamp = Date.now();
  const subject = step.toString(16).padStart(16, '0');
  const frame = envelope.frames[0];
  frame.from = timestamp - 1;
  frame.to = timestamp;
  frame.metrics = { counters: [], gauges: [], histograms: [] };
  frame.logs = [];
  frame.events = [
    [timestamp, 'experiment.exposure', {
      experiment: 'stress-evidence-v1', variant: 'test', subject
    }],
    [timestamp, 'experiment.goal', {
      metric: 'stress.goal',
      subject,
      experiments: [{ experiment: 'stress-evidence-v1', variant: 'test' }],
      value: 1
    }]
  ];
  return gzipJson(envelope);
}

function runLoadWorker({ port, rate, durationMs, bodies }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./server-load-worker.js', import.meta.url), {
      workerData: { port, rate, durationMs, bodies }
    });
    worker.once('message', (result) => {
      if (result.ok) resolve(result);
      else reject(new Error(result.error));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`server load worker exited with code ${code}`));
    });
  });
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function testD({ rate, durationMs, mode = 'smoke', profile: profileName = 'raw' }) {
  const profile = SERVER_PROFILES[profileName];
  if (!profile) throw new Error(`unknown server profile ${profileName}; expected raw or persistence`);
  if (!Number.isFinite(rate) || rate < 1) throw new Error('rate must be a number >= 1');
  if (!Number.isFinite(durationMs) || durationMs < 1) throw new Error('duration must be a number >= 1');
  if (!Object.prototype.hasOwnProperty.call(SERVER_THRESHOLDS, mode)) {
    throw new Error(`unknown gate mode ${mode}; expected smoke or full`);
  }

  const directory = await mkdtemp(join(tmpdir(), 'wardx-server-benchmark-'));
  let server;
  let agent;
  try {
    const config = await benchmarkConfig(profile, directory);
    server = createIngestServer(config);
    const address = await listen(server, 0, '127.0.0.1');
    agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
    const bodies = growingBodies(durationMs);
    const persistenceBefore = profile.persistence ? server.wardx.persistence.snapshotMetrics() : null;
    const loop = startEventLoopProbe();
    const memoryBefore = process.memoryUsage().rss;
    let peakRss = memoryBefore;
    let featureExercises = 0;
    const cpuBefore = process.cpuUsage();
    let featureError = null;
    let featureChain = Promise.resolve();
    const exerciseFeatures = async () => {
      if (featureError) return;
      try {
        const evidence = await postGzip(agent, address.port, evidenceBody(featureExercises + 1));
        if (evidence.status !== 200) throw new Error(`feature evidence sync returned ${evidence.status}`);
        const currentVersion = server.wardx.control.getConfig('demo').version;
        server.wardx.control.setValue('demo', 'message.delayMs', 1001 + featureExercises, ['client'], {
          expectedVersion: currentVersion,
          reason: 'stress concurrent control mutation'
        });
        const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        server.wardx.control.aggregateHistory('demo', {
          tier: 'hour', from: hour - 3_600_000, to: hour + 3_600_000
        });
        server.wardx.stateStore.checkpoint();
        featureExercises += 1;
      } catch (error) {
        featureError = error;
      }
    };
    if (profile.persistence) featureChain = featureChain.then(exerciseFeatures);
    const featureTimer = profile.persistence
      ? setInterval(() => {
          featureChain = featureChain.then(exerciseFeatures);
        }, 5000)
      : null;
    featureTimer?.unref?.();
    const memoryTimer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, SLICE_MS);
    memoryTimer.unref?.();
    const load = await runLoadWorker({ port: address.port, rate, durationMs, bodies });
    clearInterval(memoryTimer);
    if (featureTimer) clearInterval(featureTimer);
    await featureChain;
    if (featureError) throw featureError;
    const benchmarkElapsedMs = load.elapsedMs;
    const sent = load.sent;
    const errors = load.errors;
    const networkErrors = load.networkErrors;
    let burstOverloads = 0;
    let burstUnexpected = 0;
    if (profile.persistence) {
      const leases = Array.from(
        { length: config.capacity.maxConcurrentSyncHandlers },
        () => server.wardx.syncGate.enter()
      );
      if (leases.some((lease) => lease === null)) throw new Error('could not saturate sync concurrency gate');
      const overload = await postGzip(agent, address.port, bodies[0]);
      burstOverloads = overload.status === 503 ? 1 : 0;
      burstUnexpected = overload.status === 200 || overload.status === 503 ? 0 : 1;
      for (const release of leases) release();
      const recovery = await postGzip(agent, address.port, bodies[0]);
      if (recovery.status !== 200) burstUnexpected += 1;
    }
    if (profile.persistence) await server.wardx.persistence.flush();
    const loopStats = loop.stop();
    const cpuAfter = process.cpuUsage();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const windowsSnapshot = server.wardx.registry.get('demo').aggregator.windowsSnapshot();
    const retainedSeries = windowsSnapshot.reduce(
      (total, window) => total + window.counters.length + window.gauges.length + window.histograms.length,
      0
    );
    const persistenceAfter = profile.persistence ? server.wardx.persistence.snapshotMetrics() : null;
    const disk = profile.persistence ? persistenceDelta(persistenceBefore, persistenceAfter) : null;
    const persistenceBytes = profile.persistence
      ? (await fileSize(config.sqlite.path)) + (await fileSize(`${config.sqlite.path}-wal`))
      : 0;
    const actualRate = sent / (benchmarkElapsedMs / 1000);
    const errorRate = sent === 0 ? 1 : errors / sent;
    const { p50, p95, p99 } = load;
    const rssGrowth = peakRss - memoryBefore;
    const thresholds = thresholdsFor(mode, rate, durationMs, config);
    const violations = gateResult({
      mode,
      profile,
      durationMs,
      actualRate,
      errorRate,
      p99,
      loopStats,
      rssGrowth,
      disk,
      windows: windowsSnapshot.length,
      series: retainedSeries,
      featureExercises,
      burstOverloads,
      burstUnexpected,
      thresholds
    });

    report(`D ${profile.label} / ${mode} gate`, {
      'requested sync/s': rate,
      'duration ms': benchmarkElapsedMs.toFixed(1),
      sent,
      errors,
      'network errors': networkErrors,
      'actual sync/s': actualRate.toFixed(1),
      'error rate': errorRate.toFixed(6),
      'p50 ms': p50.toFixed(2),
      'p95 ms': p95.toFixed(2),
      'p99 ms': p99.toFixed(2),
      'event-loop p50 ms': loopStats.p50Ms.toFixed(3),
      'event-loop p99 ms': loopStats.p99Ms.toFixed(3),
      'CPU percent': cpuPercent(cpuBefore, cpuAfter, benchmarkElapsedMs).toFixed(1),
      'RSS start bytes': memoryBefore,
      'RSS peak bytes': peakRss,
      'RSS growth bytes': rssGrowth,
      'retained windows': windowsSnapshot.length,
      'retained series': retainedSeries,
      'persistence bytes': persistenceBytes,
      'disk writes': disk?.writes ?? 0,
      'disk write failures': disk?.writeFailures ?? 0,
      'disk write latency total ms': disk?.writeLatencyTotalMs.toFixed(2) ?? 'disabled',
      'disk write latency max ms': disk?.writeLatencyMaxMs.toFixed(2) ?? 'disabled',
      'pending SQLite batches': disk?.pendingBatches ?? 0,
      'pending SQLite bytes': disk?.pendingBytes ?? 0,
      'SQLite transactions': disk?.sqliteTransactions ?? 0,
      'SQLite transaction failures': disk?.sqliteTransactionFailures ?? 0,
      'SQLite busy failures': disk?.sqliteBusyFailures ?? 0,
      'WAL checkpoints': disk?.checkpoints ?? 0,
      'explicit checkpoint latency total ms': disk?.checkpointLatencyTotalMs.toFixed(2) ?? 'disabled',
      'explicit checkpoint latency max ms': disk?.checkpointLatencyMaxMs.toFixed(2) ?? 'disabled',
      'SQLite transaction latency max ms (includes automatic checkpoints)': disk?.sqliteTransactionLatencyMaxMs.toFixed(2) ?? 'disabled',
      'WAL pending frames': disk ? (disk.walPendingFrames ?? 'unavailable') : 'disabled',
      'feature exercises': featureExercises,
      'burst overload responses': burstOverloads,
      'burst unexpected responses': burstUnexpected,
      'gate violations': violations.length
    });
    report('D thresholds', thresholds);
    if (violations.length > 0) throw new Error(`server benchmark gate failed:\n- ${violations.join('\n- ')}`);
    return {
      profile: profile.id,
      mode,
      sent,
      errors,
      p50,
      p95,
      p99,
      actualRate,
      loopStats,
      disk,
      peakRss,
      retainedWindows: windowsSnapshot.length,
      retainedSeries
    };
  } finally {
    agent?.destroy();
    if (server) await server.wardx.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
