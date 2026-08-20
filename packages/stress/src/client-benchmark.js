import { WardxCore, loadSdkDefaults } from '@wardx/core';
import { gzipBuffer } from '../../node/src/compression/gzip.js';
import { memorySnapshot, report, startEventLoopProbe } from './measure.js';

function core(overrides = {}) {
  const settings = {
    ...loadSdkDefaults(),
    endpoint: 'http://127.0.0.1:9',
    projectKey: 'stress',
    project: 'demo',
    appVersion: '0.0.0',
    environment: 'stress',
    privacySalt: 'stress',
    ...overrides
  };
  return new WardxCore(settings);
}

export function testA(iterations = 10_000_000) {
  const w = core();
  const counter = w.counter('hot.path');
  if (global.gc) global.gc();
  const memBefore = memorySnapshot();
  const loop = startEventLoopProbe();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) counter.inc();
  const t1 = process.hrtime.bigint();
  const loopStats = loop.stop();
  if (global.gc) global.gc();
  const memAfter = memorySnapshot();
  const ns = Number(t1 - t0);
  const perOpNs = ns / iterations;
  const opsPerSec = 1e9 / perOpNs;
  w.snapshotFrame();
  report('A counter hot path', {
    iterations,
    'ops/s': Math.round(opsPerSec).toLocaleString('en-US'),
    'ns/op': perOpNs.toFixed(2),
    'us/op': (perOpNs / 1e3).toFixed(4),
    'rss delta bytes': memAfter.rss - memBefore.rss,
    'heapUsed delta bytes': memAfter.heapUsed - memBefore.heapUsed,
    'event-loop p99 ms': loopStats.p99Ms.toFixed(3)
  });
  return { perOpNs, opsPerSec, loopStats };
}

export async function testB({ rate, durationMs }) {
  const w = core();
  const counter = w.counter('mixed.counter');
  const hist = w.histogram('mixed.hist');
  const loop = startEventLoopProbe();
  const sliceMs = 10;
  const perSlice = Math.max(1, Math.round((rate * sliceMs) / 1000));
  const endAt = Date.now() + durationMs;
  let ops = 0;
  const t0 = process.hrtime.bigint();
  while (Date.now() < endAt) {
    const sliceStart = Date.now();
    for (let n = 0; n < perSlice; n++) {
      const lane = ops % 20;
      if (lane < 14) counter.inc();
      else if (lane < 17) hist.observe(lane);
      else if (lane < 19) w.event('mixed.event', { i: lane });
      else w.log.info('mixed_log', { i: lane });
      ops += 1;
    }
    const spent = Date.now() - sliceStart;
    if (spent < sliceMs) {
      await new Promise((resolve) => setTimeout(resolve, sliceMs - spent));
    }
  }
  const elapsedNs = Number(process.hrtime.bigint() - t0);
  const loopStats = loop.stop();
  w.snapshotFrame();
  report(`B mixed ${rate}/s for ${durationMs}ms`, {
    ops,
    'actual ops/s': Math.round(ops / (elapsedNs / 1e9)).toLocaleString('en-US'),
    'wall duration ms': (elapsedNs / 1e6).toFixed(2),
    'event-loop p99 ms': loopStats.p99Ms.toFixed(3),
    rss: process.memoryUsage().rss
  });
  return { ops, elapsedNs, loopStats };
}

export function testC() {
  const w = core({ maxBufferedEvents: 5000, maxBufferedLogs: 2000 });
  const hist = w.histogram('flush.hist');
  for (let i = 0; i < 4000; i++) {
    w.counter('flush.counter', { bucket: String(i % 50) }).inc();
    hist.observe(i % 900);
  }
  for (let i = 0; i < 4000; i++) w.event('flush.event', { i: i % 17 });
  for (let i = 0; i < 1500; i++) w.log.info('flush_log', { i: i % 9 });
  const loop = startEventLoopProbe();
  const tSnap0 = process.hrtime.bigint();
  const fitted = w.snapshotFrame();
  const tSnap1 = process.hrtime.bigint();
  const tJson0 = process.hrtime.bigint();
  const json = JSON.stringify({ frames: [fitted.frame] });
  const tJson1 = process.hrtime.bigint();
  const tGzip0 = process.hrtime.bigint();
  const compressed = gzipBuffer(json);
  const tGzip1 = process.hrtime.bigint();
  const loopStats = loop.stop();
  report('C flush spike', {
    'snapshot ns': Number(tSnap1 - tSnap0),
    'JSON.stringify ns': Number(tJson1 - tJson0),
    'gzip ns': Number(tGzip1 - tGzip0),
    'uncompressed bytes': Buffer.byteLength(json),
    'compressed bytes': compressed.length,
    'event-loop p99 ms': loopStats.p99Ms.toFixed(3)
  });
  return { compressed, json, loopStats };
}
