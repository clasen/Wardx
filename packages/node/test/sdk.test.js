import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConsoleTracer, createWardx } from '../src/index.js';
import { createIngestServer, listen } from '../../server/src/server.js';
import { testServerConfig } from '../../server/test/helpers.js';

async function withServer(fn) {
  const config = testServerConfig();
  const server = createIngestServer(config);
  const address = await listen(server, 0, '127.0.0.1');
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(server, endpoint);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('createWardx does not require connectivity', () => {
  const wardx = createWardx({
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'test-key',
    project: 'demo',
    role: 'client',
    appVersion: '1.0.0',
    environment: 'test'
  });
  wardx.counter('x').inc();
  return wardx.shutdown();
});

test('sdk syncs frames and receives remote config', async () => {
  await withServer(async (server, endpoint) => {
    const wardx = createWardx({
      endpoint,
      projectKey: 'test-key',
      project: 'demo',
      role: 'client',
      appVersion: '2.4.1',
      environment: 'test',
      aggregateIntervalMs: 60_000,
      syncIntervalMs: 60_000
    });
    try {
      for (let i = 0; i < 20; i++) {
        if (wardx._core.configStore.version === 12) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(wardx._core.configStore.version, 12);
      assert.equal(wardx.config.get('message.delayMs', 3), 1000);
      wardx.counter('match.completed', { mode: 'ranked' }).inc();
      wardx.event('match.started', { mode: 'ranked' });
      wardx.log.info('match_started', { players: 4 });
      await wardx.flush();
      assert.ok(server.wardx.sink.frameCount >= 1);
      const last = server.wardx.sink.envelopes.at(-1);
      const counters = last.frames.flatMap((frame) => frame.metrics.counters);
      assert.ok(counters.some((row) => row[0] === 'match.completed' && row[2] === 1));
    } finally {
      await wardx.shutdown();
    }
  });
});

test('tracer receives measure records and a sync record on flush', async () => {
  await withServer(async (_server, endpoint) => {
    const records = [];
    const wardx = createWardx({
      endpoint,
      projectKey: 'test-key',
      project: 'demo',
      role: 'client',
      appVersion: '1.0.0',
      environment: 'test',
      aggregateIntervalMs: 60_000,
      syncIntervalMs: 60_000,
      tracer: {
        measure: (record) => records.push({ hook: 'measure', ...record }),
        sync: (record) => records.push({ hook: 'sync', ...record })
      }
    });
    try {
      wardx.counter('match.completed', { mode: 'ranked' }).inc();
      await wardx.flush();
      const measures = records.filter((row) => row.hook === 'measure');
      const syncs = records.filter((row) => row.hook === 'sync' && row.phase === 'flush');
      assert.equal(measures.length, 1);
      assert.equal(measures[0].name, 'match.completed');
      assert.ok(syncs.length >= 1);
      assert.equal(syncs[0].ok, true);
      assert.ok(syncs[0].frames >= 1);
    } finally {
      await wardx.shutdown();
    }
  });
});

test('createConsoleTracer writes one line per measure', () => {
  const lines = [];
  const tracer = createConsoleTracer({
    stream: { write: (chunk) => lines.push(String(chunk)) }
  });
  tracer.measure({
    type: 'counter',
    name: 'match.completed',
    dims: { mode: 'ranked' },
    op: 'inc',
    value: 1,
    noop: false
  });
  tracer.sync({
    phase: 'flush',
    frames: 1,
    bytesCompressed: 120,
    ms: 3.25,
    ok: true,
    configVersion: 12
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /counter\s+match\.completed mode=ranked {2}inc 1/);
  assert.match(lines[1], /sync\s+flush frames=1 gzip=120B 3\.3ms ok config=12/);
});
