import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWardx } from '../src/index.js';
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
