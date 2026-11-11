import { createWardx } from '../src/index.js';

const [endpoint] = process.argv.slice(2);
if (!endpoint) throw new Error('usage: bun bun-client.js <endpoint>');
if (!process.versions.bun) throw new Error('bun-client.js must run under Bun');

const wardx = createWardx({
  endpoint,
  projectKey: 'bun-interop-key',
  project: 'demo',
  role: 'backend',
  appVersion: '1.0.0',
  environment: 'test',
  privacySalt: 'bun-interop-salt',
  attributes: { tier: 1 },
  aggregateIntervalMs: 60_000,
  syncIntervalMs: 60_000
});

const configSync = await wardx.flush();
const remote = wardx.config.get('interop.remote', 'fallback', { subjectId: 'interop-subject' });
wardx.counter('interop.counter', { runtime: 'bun' }).add(3);
wardx.distinct('interop.hids').add('interop-private-hid');
wardx.histogram('interop.latency').observe(12);
wardx.event('interop.event', { runtime: 'bun' });
wardx.log.info('interop_log', { runtime: 'bun' });
wardx.experiment.goal('interop.goal', { subjectId: 'interop-subject', value: 2 });
const dataSync = await wardx.flush();
await wardx.shutdown();

process.stdout.write(`${JSON.stringify({ ok: configSync.ok && dataSync.ok, remote })}\n`);
