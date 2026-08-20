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
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
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
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    assert.equal(json.configVersion, 12);
    assert.equal(json.config, undefined);
  });
});

test('admin config replace bumps version for subsequent syncs', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const put = await fetch(`${base}/v1/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-wardx-admin-key': 'admin-key' },
      body: JSON.stringify({
        version: 13,
        values: { 'message.delayMs': 400 },
        experiments: []
      })
    });
    assert.equal(put.status, 200);
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope({ configVersion: 12, frames: [] }))
    });
    const json = await res.json();
    assert.equal(json.configVersion, 13);
    assert.equal(json.config.values['message.delayMs'], 400);
  });
});

test('one-minute aggregator merges counters', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope())
    });
    await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-wardx-key': 'test-key'
      },
      body: gzipJson(sampleEnvelope())
    });
    const windows = server.wardx.aggregator.snapshot();
    const total = windows
      .flatMap((window) => window.counters)
      .filter((row) => row.name === 'match.completed')
      .reduce((sum, row) => sum + row.value, 0);
    assert.equal(total, 8);
  });
});
