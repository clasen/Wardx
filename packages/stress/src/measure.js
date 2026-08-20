import { monitorEventLoopDelay } from 'node:perf_hooks';

export function percentile(values, p) {
  if (values.length === 0) throw new Error('percentile of empty sample');
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function formatNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} us`;
  return `${ns.toFixed(2)} ns`;
}

export function startEventLoopProbe() {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  return {
    stop() {
      histogram.disable();
      return {
        meanMs: histogram.mean / 1e6,
        p50Ms: histogram.percentile(50) / 1e6,
        p99Ms: histogram.percentile(99) / 1e6,
        maxMs: histogram.max / 1e6
      };
    }
  };
}

export function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external
  };
}

export function report(name, fields) {
  process.stdout.write(`\n[${name}]\n`);
  for (const [key, value] of Object.entries(fields)) {
    process.stdout.write(`  ${key}: ${value}\n`);
  }
}
