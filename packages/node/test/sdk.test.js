import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:net';
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
    environment: 'test',
    privacySalt: 'test-salt'
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
      privacySalt: 'test-salt',
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

test('independent SDK workers merge overlapping distinct sketches at one server', async () => {
  await withServer(async (server, endpoint) => {
    const workerSubjects = [
      ['hid-a', 'hid-b', 'hid-c'],
      ['hid-b', 'hid-c', 'hid-d'],
      ['hid-a', 'hid-e']
    ];
    const workers = workerSubjects.map(() => createWardx({
      endpoint,
      projectKey: 'test-key',
      project: 'demo',
      role: 'game-server',
      appVersion: '2.4.1',
      environment: 'test',
      privacySalt: 'shared-cluster-privacy-salt',
      aggregateIntervalMs: 60_000,
      syncIntervalMs: 60_000
    }));
    try {
      for (let index = 0; index < workers.length; index += 1) {
        const distinct = workers[index].distinct('cluster.active_hids', { result: 'violating' });
        for (const subject of workerSubjects[index]) distinct.add(subject);
      }
      await Promise.all(workers.map((worker) => worker.flush()));

      const windows = server.wardx.registry.get('demo').aggregator.snapshot({
        role: 'game-server',
        names: ['cluster.active_hids']
      });
      const rows = windows.flatMap((window) => window.distincts);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].precision, 9);
      assert.ok(rows[0].estimate >= 4 && rows[0].estimate <= 6, String(rows[0].estimate));

      const envelopes = server.wardx.sink.envelopes.filter(
        (envelope) => envelope.client.role === 'game-server'
      );
      assert.equal(new Set(envelopes.map((envelope) => envelope.client.instanceId)).size, 3);
      assert.doesNotMatch(JSON.stringify(envelopes), /hid-a|hid-b|hid-c|hid-d|hid-e/);
    } finally {
      await Promise.all(workers.map((worker) => worker.shutdown()));
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
      privacySalt: 'test-salt',
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

test('concurrent shutdown callers share final flush and close once', async () => {
  let releaseBootstrap;
  let posts = 0;
  let closes = 0;
  const bootstrap = new Promise((resolve) => {
    releaseBootstrap = resolve;
  });
  const wardx = createWardx({
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'test-key',
    project: 'demo',
    role: 'client',
    appVersion: '1.0.0',
    environment: 'test',
    privacySalt: 'test-salt',
    aggregateIntervalMs: 60_000,
    syncIntervalMs: 60_000
  });
  wardx._transport = {
    post: async () => {
      posts += 1;
      if (posts === 1) await bootstrap;
      return { ok: true, status: 200, json: { ok: true, configVersion: 0 } };
    },
    close: () => {
      closes += 1;
    }
  };
  await new Promise((resolve) => setImmediate(resolve));
  wardx.event('pending-at-shutdown');
  const first = wardx.shutdown();
  const second = wardx.shutdown();
  assert.equal(first, second);
  releaseBootstrap();
  await Promise.all([first, second]);
  assert.equal(posts, 2);
  assert.equal(closes, 1);
});

test('failed frames stay at-most-once and frames_failed is sent on the next flush', async () => {
  const envelopes = [];
  let posts = 0;
  const wardx = createWardx({
    endpoint: 'http://127.0.0.1:1',
    projectKey: 'test-key',
    project: 'demo',
    role: 'client',
    appVersion: '1.0.0',
    environment: 'test',
    privacySalt: 'test-salt',
    aggregateIntervalMs: 60_000,
    syncIntervalMs: 60_000
  });
  wardx._transport = {
    post: async (body) => {
      posts += 1;
      envelopes.push(JSON.parse(gunzipSync(body).toString('utf8')));
      if (posts === 2) return { ok: false, status: 503, json: null };
      return { ok: true, status: 200, json: { ok: true, configVersion: 0 } };
    },
    close() {}
  };
  await new Promise((resolve) => setImmediate(resolve));
  wardx.counter('lost-on-failure').inc();
  await wardx.flush();
  await wardx.flush();
  const failedMetric = envelopes[2].frames
    .flatMap((frame) => frame.metrics.counters)
    .find((row) => row[0] === 'wardx.internal.frames_failed');
  const lostCounterAttempts = envelopes
    .flatMap((envelope) => envelope.frames)
    .flatMap((frame) => frame.metrics.counters)
    .filter((row) => row[0] === 'lost-on-failure');
  assert.equal(failedMetric[2], 1);
  assert.equal(lostCounterAttempts.length, 1);
  await wardx.shutdown();
});

test('real connection failure is at-most-once and reports frames_failed after recovery', async () => {
  const probe = createServer();
  const reserved = await listen(probe, 0, '127.0.0.1');
  const port = reserved.port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

  const endpoint = `http://127.0.0.1:${port}`;
  const wardx = createWardx({
    endpoint,
    projectKey: 'test-key',
    project: 'demo',
    role: 'client',
    appVersion: '1.0.0',
    environment: 'test',
    privacySalt: 'test-salt',
    aggregateIntervalMs: 60_000,
    syncIntervalMs: 60_000,
    httpTimeoutMs: 1000
  });
  await wardx._syncChain;
  wardx.counter('discarded-on-failure').inc();
  await wardx.flush();

  const server = createIngestServer(testServerConfig());
  await listen(server, port, '127.0.0.1');
  try {
    await wardx.flush();
    const receivedCounters = server.wardx.sink.envelopes
      .flatMap((envelope) => envelope.frames)
      .flatMap((frame) => frame.metrics.counters);
    assert.equal(receivedCounters.some((row) => row[0] === 'discarded-on-failure'), false);
    const failed = receivedCounters.find((row) => row[0] === 'wardx.internal.frames_failed');
    assert.ok(failed);
    assert.ok(failed[2] >= 1);
  } finally {
    await wardx.shutdown();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
