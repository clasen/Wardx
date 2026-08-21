import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIngestServer, listen } from '../src/server.js';
import { gzipJson, sampleEnvelope, testServerConfig } from './helpers.js';

async function withServer(config, fn) {
  const server = createIngestServer(config);
  const address = await listen(server, config.port, config.host);
  const base = `http://${address.address}:${address.port}`;
  try {
    return await fn(server, base);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function syncHeaders(key = 'test-key') {
  return {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'x-wardx-key': key
  };
}

test('POST /v1/sync rejects missing project key', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const res = await fetch(`${base}/v1/sync`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });
});

test('POST /v1/sync accepts gzip frames and returns config when versions differ', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope())
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.configVersion, 12);
    assert.equal(json.config.values['message.delayMs'], 1000);
    assert.equal(server.wardx.sink.frameCount, 1);
  });
});

test('POST /v1/sync omits config when versions match', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    assert.equal(json.configVersion, 12);
    assert.equal(json.config, undefined);
  });
});

test('ControlService setValue bumps version for subsequent syncs', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    const result = server.wardx.control.setValue('demo', 'message.delayMs', 400, ['client']);
    assert.equal(result.version, 13);
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    assert.equal(json.configVersion, 13);
    assert.equal(json.config.values['message.delayMs'], 400);
  });
});

test('one-minute aggregator merges counters per project', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope())
    });
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope())
    });
    const windows = server.wardx.control.aggregates('demo');
    const total = windows
      .flatMap((window) => window.counters)
      .filter((row) => row.name === 'match.completed')
      .reduce((sum, row) => sum + row.value, 0);
    assert.equal(total, 8);
  });
});

test('telemetry and config are isolated per project', async () => {
  const config = testServerConfig({
    projectKeys: { 'test-key': 'demo', 'other-key': 'other' },
    projects: {
      demo: {
        version: 12,
        values: { 'message.delayMs': 1000 },
        keyRoles: { 'message.delayMs': ['client'] },
        experiments: []
      },
      other: {
        version: 3,
        values: { 'message.delayMs': 50 },
        keyRoles: { 'message.delayMs': ['client'] },
        experiments: []
      }
    }
  });
  await withServer(config, async (server, base) => {
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders('test-key'),
      body: gzipJson(sampleEnvelope({ project: 'demo' }))
    });
    const otherSync = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders('other-key'),
      body: gzipJson(sampleEnvelope({ project: 'other', configVersion: 3, frames: [] }))
    });
    const otherJson = await otherSync.json();
    assert.equal(otherJson.configVersion, 3);
    assert.equal(otherJson.config, undefined);
    const demoWindows = server.wardx.control.aggregates('demo');
    const otherWindows = server.wardx.control.aggregates('other');
    assert.equal(
      demoWindows.flatMap((window) => window.counters).some((row) => row.name === 'match.completed'),
      true
    );
    assert.equal(otherWindows.length, 0);
    assert.equal(server.wardx.control.getConfig('demo').values['message.delayMs'], 1000);
    assert.equal(server.wardx.control.getConfig('other').values['message.delayMs'], 50);
  });
});

test('POST /v1/sync rejects missing client.role', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope({ client: { role: '' }, frames: [] }))
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'client.role is required');
  });
});

test('GET /v1/admin/aggregates is gone', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const res = await fetch(`${base}/v1/admin/aggregates`);
    assert.equal(res.status, 404);
  });
});
