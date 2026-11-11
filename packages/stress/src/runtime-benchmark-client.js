const RUNS = 7;
const now = () => process.hrtime.bigint();
const [mode, endpoint] = process.argv.slice(2);

if (mode === 'startup') {
  const { createWardx } = await import('wardx');
  await createWardx({ enabled: false }).shutdown();
} else if (mode === 'measure') {
  await measure(endpoint);
} else {
  throw new Error('usage: runtime-benchmark-client.js <startup|measure> [endpoint]');
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function bench(results, name, ops, fn) {
  await fn();
  const samples = [];
  for (let run = 0; run < RUNS; run++) {
    const t0 = now();
    await fn();
    samples.push(Number(now() - t0) / ops);
  }
  results.push([name, median(samples)]);
}

async function measure(endpoint) {
  if (!endpoint) throw new Error('measure mode requires an ingest endpoint');
  const { WardxCore, assignVariant, loadSdkDefaults } = await import('@wardx/core');
  const { createWardx } = await import('wardx');
  const { gzipEnvelope } = await import('../../node/src/compression/gzip.js');
  const core = (overrides = {}) => new WardxCore({
    ...loadSdkDefaults(),
    endpoint: 'http://127.0.0.1:9', projectKey: 'stress', project: 'demo', role: 'client',
    appVersion: '0.0.0', environment: 'stress', privacySalt: 'stress', ...overrides
  });
  const results = [];

  {
    const counter = core().counter('hot.path');
    const n = 10_000_000;
    await bench(results, 'counter.inc() on a bound handle (ns)', n, () => {
      for (let i = 0; i < n; i++) counter.inc();
    });
  }
  {
    const w = core();
    const modes = ['ranked', 'casual', 'arena', 'coop'];
    const n = 1_000_000;
    await bench(results, 'counter(name, dims).inc() (ns)', n, () => {
      for (let i = 0; i < n; i++) w.counter('match.completed', { mode: modes[i & 3] }).inc();
    });
  }
  {
    const histogram = core().histogram('latency');
    const n = 5_000_000;
    await bench(results, 'histogram.observe() (ns)', n, () => {
      for (let i = 0; i < n; i++) histogram.observe(i % 900);
    });
  }
  {
    const distinct = core().distinct('users');
    const n = 1_000_000;
    await bench(results, 'distinct.add() (ns)', n, () => {
      for (let i = 0; i < n; i++) distinct.add(`user-${i}`);
    });
  }
  {
    const n = 1_000;
    await bench(results, 'event() + log.info(), including snapshot (ns)', n * 2, async () => {
      const w = core();
      for (let i = 0; i < n; i++) {
        w.event('match.started', { mode: 'ranked', i: i % 17 });
        w.log.info('match_started', { players: i % 9 });
      }
      await w._snapshotIfDirtyAsync();
    });
  }
  {
    const experiment = {
      id: 'message-delay-v1', enabled: true, allocation: 1, salt: '3ad8f9',
      variants: [
        { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
        { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
      ]
    };
    const n = 1_000_000;
    await bench(results, 'Experiment variant assignment (ns)', n, () => {
      for (let i = 0; i < n; i++) assignVariant(experiment, `subject-${i}`);
    });
  }
  {
    const series = 5000;
    await bench(results, 'Flush of 5,000 series: snapshot + gzip (ms)', 1e6, async () => {
      const w = core({ maxSeriesPerMetric: series });
      for (let i = 0; i < series; i++) {
        w.counter('flush.counter', { bucket: String(i) }).inc();
        w.histogram('flush.hist', { bucket: String(i) }).observe(i % 900);
      }
      for (let i = 0; i < 4000; i++) w.event('flush.event', { i: i % 17 });
      for (let i = 0; i < 1500; i++) w.log.info('flush_log', { i: i % 9 });
      await w._snapshotIfDirtyAsync();
      await gzipEnvelope({}, w._takePendingBatch().jsons);
    });
  }
  {
    const wardx = createWardx({
      endpoint, projectKey: 'runtime-benchmark-key', project: 'demo', role: 'backend', appVersion: '1.0.0',
      environment: 'stress', privacySalt: 'stress', aggregateIntervalMs: 60_000, syncIntervalMs: 60_000
    });
    await wardx.flush();
    const counter = wardx.counter('e2e.counter');
    const histogram = wardx.histogram('e2e.hist');
    const warmup = 30;
    const flushes = 300;
    const latencies = [];
    for (let i = 0; i < warmup + flushes; i++) {
      for (let j = 0; j < 200; j++) {
        counter.inc();
        histogram.observe(j);
      }
      wardx.event('e2e.event', { i });
      const t0 = now();
      const result = await wardx.flush();
      if (!result.ok) throw new Error('flush did not reach the ingest server');
      if (i >= warmup) latencies.push(Number(now() - t0) / 1e6);
    }
    await wardx.shutdown();
    latencies.sort((a, b) => a - b);
    results.push(['flush() to a local server, p50 (ms)', latencies[Math.floor(flushes * 0.5)]]);
    results.push(['flush() to a local server, p99 (ms)', latencies[Math.floor(flushes * 0.99)]]);
  }

  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`;
  process.stdout.write(`${JSON.stringify({ runtime, results })}\n`);
}
