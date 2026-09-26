import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
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

export async function testA(iterations = 10_000_000) {
  const w = core();
  const counter = w.counter('hot.path');
  if (global.gc) global.gc();
  const memBefore = memorySnapshot();
  const loop = startEventLoopProbe();
  await delay(20);
  const cpuStart = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) counter.inc();
  const t1 = process.hrtime.bigint();
  const cpu = process.cpuUsage(cpuStart);
  await delay(20);
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
    'CPU user ms': cpu.user / 1000,
    'CPU system ms': cpu.system / 1000,
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

export async function testC(seriesCount = 5000) {
  const w = core({ maxSeriesPerMetric: seriesCount });
  const counters = [];
  const histograms = [];
  for (let i = 0; i < seriesCount; i++) {
    const dims = { bucket: String(i) };
    counters.push(w.counter('flush.counter', dims));
    histograms.push(w.histogram('flush.hist', dims));
  }
  if (global.gc) global.gc();
  const memBefore = memorySnapshot();
  const session = new Session();
  session.connect();
  const post = promisify(session.post.bind(session));
  const loop = startEventLoopProbe();
  let peakRss = memBefore.rss;
  let peakHeap = memBefore.heapUsed;
  const sampleMemory = () => {
    const memory = memorySnapshot();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  };
  const memoryTimer = setInterval(sampleMemory, 10);
  try {
    await post('HeapProfiler.startSampling', {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    });
    await delay(20);
    const cpuStart = process.cpuUsage();
    const observations = 100000;
    const tObserve0 = process.hrtime.bigint();
    for (let i = 0; i < observations; i++) {
      counters[i % seriesCount].inc();
      histograms[i % seriesCount].observe(i % 900);
    }
    const tObserve1 = process.hrtime.bigint();
    for (let i = 0; i < 4000; i++) w.event('flush.event', { i: i % 17 });
    for (let i = 0; i < 1500; i++) w.log.info('flush_log', { i: i % 9 });
    const tSnap0 = process.hrtime.bigint();
    const fitted = w.snapshotFrame();
    const tSnap1 = process.hrtime.bigint();
    sampleMemory();
    const tJson0 = process.hrtime.bigint();
    const json = JSON.stringify({ frames: w.takePendingFrames() });
    const tJson1 = process.hrtime.bigint();
    sampleMemory();
    const tGzip0 = process.hrtime.bigint();
    const compressed = await gzipBuffer(json);
    const tGzip1 = process.hrtime.bigint();
    const cpu = process.cpuUsage(cpuStart);
    sampleMemory();
    await delay(20);
    const loopStats = loop.stop();
    const { profile } = await post('HeapProfiler.stopSampling');
    let allocatedBytes = 0;
    const nodes = [profile.head];
    while (nodes.length > 0) {
      const node = nodes.pop();
      allocatedBytes += node.selfSize;
      nodes.push(...node.children);
    }
    if (global.gc) global.gc();
    const memAfter = memorySnapshot();
    assert.equal(fitted.droppedRows, 0);
    assert.equal(fitted.frames.flatMap((frame) => frame.metrics.histograms).length, seriesCount);
    assert.equal(fitted.frames.flatMap((frame) => frame.metrics.histograms)
      .reduce((sum, row) => sum + row[2].count, 0), observations);
    assert.ok(fitted.frames.length <= w.settings.maxPendingFrames);
    assert.ok(fitted.jsons.every((part) => Buffer.byteLength(part) <= w.settings.maxFrameBytes));
    report(`C flush spike (${seriesCount} counter + ${seriesCount} histogram series)`, {
      observations,
      'observe ns/op (counter + histogram)': Number(tObserve1 - tObserve0) / observations,
      'snapshot ns': Number(tSnap1 - tSnap0),
      'JSON.stringify ns': Number(tJson1 - tJson0),
      'async gzip wall ns': Number(tGzip1 - tGzip0),
      'CPU user ms': cpu.user / 1000,
      'CPU system ms': cpu.system / 1000,
      'allocated bytes (sampling estimate, includes GC)': allocatedBytes,
      'peak sampled RSS delta bytes': peakRss - memBefore.rss,
      'peak sampled heap delta bytes': peakHeap - memBefore.heapUsed,
      'final heap delta bytes': memAfter.heapUsed - memBefore.heapUsed,
      'forced GC': Boolean(global.gc),
      frames: fitted.frames.length,
      'uncompressed bytes': Buffer.byteLength(json),
      'compressed bytes': compressed.length,
      'event-loop p99 ms': loopStats.p99Ms.toFixed(3),
      'event-loop max ms': loopStats.maxMs.toFixed(3)
    });
    return { compressed, json, loopStats };
  } finally {
    clearInterval(memoryTimer);
    loop.stop();
    session.disconnect();
  }
}
