import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeTool } from '../src/mcp/tools.js';
import { loadLogStats, logStatsPath, validateLogStats } from '../src/control/persist.js';
import { loadServerConfig } from '../src/loadConfig.js';
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

function persistLogEnvelope(now = Date.now()) {
  return sampleEnvelope({
    configVersion: 12,
    frames: [
      {
        seq: 1,
        from: now,
        to: now + 1,
        metrics: { counters: [], gauges: [], histograms: [] },
        events: [],
        logs: [
          [now - 5, 'error', 'payment_failed', { code: 'timeout', stack: 'PaymentError: timeout' }],
          [now, 'info', 'match_started', { mode: 'ranked' }]
        ]
      }
    ]
  });
}

test('validateLogStats rejects unknown keys', () => {
  assert.throws(() => validateLogStats({ extra: 1 }), /unknown key: extra/);
  assert.throws(
    () =>
      validateLogStats({
        projects: {
          demo: {
            payment_failed: { client: { error: { count: 1, extra: 1 } } }
          }
        }
      }),
    /unknown key: extra/
  );
});

test('loadLogStats returns empty when the sidecar is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  try {
    const snapshot = loadLogStats(join(dir, 'missing.log-stats.json'));
    assert.deepEqual(snapshot, { projects: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlisted historical log counts persist without attrs across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  const config = testServerConfig({ port: 0 });
  config.history.clockSkewAllowanceMs = 1;
  config.history.maxAcceptedPastAgeMs = 3_600_000;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const now = Date.now() - 600_000;
  const hourFrom = Math.floor(now / 3_600_000) * 3_600_000;
  try {
    const first = loadServerConfig(path);
    await withServer(first, async (server, base) => {
      executeTool(server.wardx.control, 'set_persist_log', {
        project: 'demo', name: 'payment_failed', expectedVersion: 12, reason: 'retain payment failure count'
      });
      const res = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-wardx-key': 'test-key'
        },
        body: gzipJson(persistLogEnvelope(now))
      });
      assert.equal(res.status, 200);
      await server.wardx.persistence.flush();
      assert.equal(existsSync(logStatsPath(path)), false);
      const windows = executeTool(server.wardx.control, 'get_aggregates', { project: 'demo' });
      const row = windows.windows[0].logNames.find((item) => item.name === 'payment_failed');
      assert.equal(row.count, 1);
      assert.equal(row.persist, true);
      const overview = executeTool(server.wardx.control, 'get_project_overview', { project: 'demo' });
      assert.deepEqual(overview.persistLogs, ['payment_failed']);
      const outcome = overview.roles.client.outcomes.find(
        (item) => item.kind === 'log' && item.name === 'payment_failed'
      );
      assert.equal(outcome.count, 1);
      assert.equal(outcome.level, 'error');
      assert.equal(outcome.exemplar.attrs.code, 'timeout');
    });
    const second = loadServerConfig(path);
    const restarted = createIngestServer(second);
    const overview = executeTool(restarted.wardx.control, 'get_project_overview', { project: 'demo' });
    assert.deepEqual(overview.persistLogs, ['payment_failed']);
    const history = executeTool(restarted.wardx.control, 'get_aggregate_history', {
      project: 'demo', tier: 'hour', from: hourFrom, to: hourFrom + 3_600_000,
      role: 'client', names: ['payment_failed']
    });
    assert.equal(history.buckets[0].rows[0].count, 1);
    assert.equal(history.buckets[0].rows[0].level, 'error');
    assert.equal(history.buckets[0].rows[0].attrs, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs not on persistLogs do not create a log-stats sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  try {
    await withServer(loadServerConfig(path), async (_server, base) => {
      const res = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-wardx-key': 'test-key'
        },
        body: gzipJson(persistLogEnvelope())
      });
      assert.equal(res.status, 200);
    });
    assert.equal(existsSync(logStatsPath(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete_persist_log drops lifetime stats from the sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  try {
    await withServer(loadServerConfig(path), async (server, base) => {
      executeTool(server.wardx.control, 'set_persist_log', {
        project: 'demo', name: 'payment_failed', expectedVersion: 12, reason: 'retain payment failures'
      });
      const res = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-wardx-key': 'test-key'
        },
        body: gzipJson(persistLogEnvelope())
      });
      assert.equal(res.status, 200);
      await server.wardx.persistence.flush();
      executeTool(server.wardx.control, 'delete_persist_log', {
        project: 'demo', name: 'payment_failed', expectedVersion: 13, reason: 'stop retaining payment failures'
      });
      await server.wardx.persistence.flush();
      assert.equal(existsSync(logStatsPath(path)), false);
      const overview = executeTool(server.wardx.control, 'get_project_overview', { project: 'demo' });
      assert.equal(
        overview.roles.client.outcomes.find((item) => item.kind === 'log'),
        undefined
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer ignores a corrupt obsolete log-stats sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(logStatsPath(path), `${JSON.stringify({ nope: true })}\n`);
  try {
    const server = createIngestServer(loadServerConfig(path));
    server.wardx.stateStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
