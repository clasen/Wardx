import http from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    label: 'raw NullSink / persistence disabled (upper bound)',
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

function percentileFromSorted(values, p) {
  if (values.length === 0) throw new Error('percentile of empty sample');
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return values[index];
}

function persistenceDelta(before, after) {
  return {
    writes: after.writes - before.writes,
    writeFailures: after.writeFailures - before.writeFailures,
    writeLatencyTotalMs: after.writeLatencyMs.total - before.writeLatencyMs.total,
    writeLatencyMaxMs: after.writeLatencyMs.max,
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

function gateResult({ mode, profile, durationMs, actualRate, errorRate, p99, loopStats, rssGrowth, disk, windows, series, thresholds }) {
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
  const configPath = join(directory, 'wardx-server.json');
  await writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return loadServerConfig(configPath);
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
    const latencies = [];
    const memoryBefore = process.memoryUsage().rss;
    let peakRss = memoryBefore;
    let errors = 0;
    let networkErrors = 0;
    let sent = 0;
    let slice = 0;
    const cpuBefore = process.cpuUsage();
    const startedNs = process.hrtime.bigint();
    const deadlineNs = startedNs + BigInt(Math.round(durationMs * 1e6));

    while (process.hrtime.bigint() < deadlineNs) {
      const sliceStartedNs = process.hrtime.bigint();
      const batchSize = Math.max(1, Math.round((rate * SLICE_MS) / 1000));
      const body = bodies[Math.min(slice, bodies.length - 1)];
      const results = await Promise.all(Array.from({ length: batchSize }, () => postGzip(agent, address.port, body)));
      for (const result of results) {
        sent += 1;
        latencies.push(result.ns);
        if (result.status !== 200) errors += 1;
        if (result.networkError) networkErrors += 1;
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      slice += 1;
      const spentMs = Number(process.hrtime.bigint() - sliceStartedNs) / 1e6;
      if (spentMs < SLICE_MS) await new Promise((resolve) => setTimeout(resolve, SLICE_MS - spentMs));
    }

    const benchmarkElapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
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
    const persistenceBytes = profile.persistence ? (await stat(`${config.configPath}.aggregate-windows.json`)).size : 0;
    const actualRate = sent / (benchmarkElapsedMs / 1000);
    const errorRate = sent === 0 ? 1 : errors / sent;
    latencies.sort((a, b) => a - b);
    const p50 = percentileFromSorted(latencies, 50) / 1e6;
    const p95 = percentileFromSorted(latencies, 95) / 1e6;
    const p99 = percentileFromSorted(latencies, 99) / 1e6;
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
