#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ReadinessMonitor } from './monitor.js';

async function main() {
  if (process.argv.length !== 3) throw new Error('one monitor configuration path is required');
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const monitor = new ReadinessMonitor(config);
  let timer;
  let stopping = false;
  let deliveryFailed = false;
  const stop = async () => {
    stopping = true;
    clearTimeout(timer);
    try {
      await monitor.close();
    } catch {
      process.stderr.write('Wardx readiness monitor could not stop cleanly.\n');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const tick = async () => {
    try {
      const result = await monitor.check();
      if (stopping) return;
      if (result.notification === 'failed' && !deliveryFailed) {
        process.stderr.write('Wardx readiness monitor webhook delivery failed.\n');
        deliveryFailed = true;
      } else if (result.notification === 'sent' && deliveryFailed) {
        process.stderr.write('Wardx readiness monitor webhook delivery recovered.\n');
        deliveryFailed = false;
      }
      timer = setTimeout(tick, monitor.config.intervalMs);
    } catch {
      process.stderr.write('Wardx readiness monitor stopped after an unexpected error.\n');
      process.exitCode = 1;
      await stop();
    }
  };
  await tick();
}

main().catch(() => {
  process.stderr.write('Wardx readiness monitor could not start. Check its configuration and webhook environment variable.\n');
  process.exitCode = 1;
});
