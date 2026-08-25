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
    await server.wardx.stop();
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

test('POST /v1/sync rejects bounded historical persistence overload before mutation', async () => {
  const config = testServerConfig();
  config.sqlite.maxPendingBytes = 1;
  await withServer(config, async (server, base) => {
    const response = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope())
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'overloaded' });
    assert.equal(server.wardx.sink.frameCount, 0);
    assert.deepEqual(server.wardx.control.aggregates('demo'), []);
    assert.equal(server.wardx.experimentLedger.totals('demo', 'missing').length, 0);
  });
});

test('POST /v1/sync bounds decoded gzip bytes and distinguishes corrupt gzip', async () => {
  const oversized = sampleEnvelope({
    client: { role: 'client'.repeat(100) },
    frames: []
  });
  const compressed = gzipJson(oversized);
  const maxRequestBytes = compressed.length + 1;
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > maxRequestBytes);

  await withServer(testServerConfig({ maxRequestBytes }), async (_server, base) => {
    const tooLarge = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: compressed
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { ok: false, error: 'payload too large' });

    const corrupt = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: Buffer.from('not-gzip')
    });
    assert.equal(corrupt.status, 400);
    assert.deepEqual(await corrupt.json(), { ok: false, error: 'invalid gzip' });
  });
});

test('POST /v1/sync accepts plain and gzip envelopes at the exact decoded limit', async () => {
  const envelope = sampleEnvelope({ frames: [] });
  const plain = Buffer.from(JSON.stringify(envelope));
  await withServer(testServerConfig({ maxRequestBytes: plain.length }), async (_server, base) => {
    const plainResponse = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wardx-key': 'test-key' },
      body: plain
    });
    assert.equal(plainResponse.status, 200);

    const gzipResponse = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(envelope)
    });
    assert.equal(gzipResponse.status, 200);
  });
});

test('POST /v1/sync rejects unsupported content encoding', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const response = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'br',
        'x-wardx-key': 'test-key'
      },
      body: Buffer.from('{}')
    });
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { ok: false, error: 'unsupported content encoding' });
  });
});

test('POST /v1/sync rejects a malformed tuple before mutating state', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    const envelope = sampleEnvelope();
    envelope.frames[0].metrics.counters[0][2] = '4';
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(envelope)
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /finite number/);
    assert.equal(server.wardx.sink.frameCount, 0);
    assert.deepEqual(server.wardx.control.aggregates('demo'), []);
    assert.deepEqual(server.wardx.control.recentClients('demo'), []);
    assert.deepEqual(server.wardx.control.recentLogs('demo'), []);
  });
});

test('POST /v1/sync returns a non-sensitive 500 and reports unexpected handler failures', async () => {
  await withServer(testServerConfig(), async (server, base) => {
    const reports = [];
    server.wardx.diagnostics.report = (...args) => reports.push(args);
    server.wardx.sink.ingest = () => {
      throw new Error('local sink detail');
    };
    const response = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope())
    });

    assert.equal(response.status, 500);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, { ok: false, error: 'internal' });
    assert.doesNotMatch(JSON.stringify(responseBody), /local sink detail|test-key/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], 'http.unexpected');
    assert.match(reports[0][1].message, /local sink detail/);
    assert.deepEqual(reports[0][2], { method: 'POST', path: '/v1/sync' });
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
    const result = server.wardx.control.setValue('demo', 'message.delayMs', 400, ['client'], {
      expectedVersion: 12,
      reason: 'test update'
    });
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
    credentials: {
      'test-key': {
        label: 'demo-client',
        project: 'demo',
        allowedRoles: ['client'],
        trustedForDecisions: false,
        enabled: true
      },
      'other-key': {
        label: 'other-client',
        project: 'other',
        allowedRoles: ['client'],
        trustedForDecisions: false,
        enabled: true
      }
    },
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

test('POST /v1/sync rejects a role outside the credential scope without mutation', async () => {
  const config = testServerConfig();
  config.credentials['test-key'].allowedRoles = ['client'];
  await withServer(config, async (server, base) => {
    const res = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: syncHeaders(),
      body: gzipJson(sampleEnvelope({ client: { role: 'game-server' } }))
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, error: 'role not allowed' });
    assert.deepEqual(server.wardx.control.aggregates('demo'), []);
    assert.deepEqual(server.wardx.control.recentClients('demo'), []);
  });
});

test('GET /v1/admin/aggregates is gone', async () => {
  await withServer(testServerConfig(), async (_server, base) => {
    const res = await fetch(`${base}/v1/admin/aggregates`);
    assert.equal(res.status, 404);
  });
});
