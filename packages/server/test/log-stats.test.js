import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('allowlisted log rollups persist across ingest server restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  try {
    const first = loadServerConfig(path);
    await withServer(first, async (server, base) => {
      executeTool(server.wardx.control, 'set_persist_log', { project: 'demo', name: 'payment_failed' });
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
      const saved = JSON.parse(readFileSync(logStatsPath(path), 'utf8'));
      assert.equal(saved.projects.demo.payment_failed.client.error.count, 1);
      assert.equal(saved.projects.demo.payment_failed.client.error.exemplar.attrs.code, 'timeout');
      assert.equal(saved.projects.demo.match_started, undefined);
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
    const outcome = overview.roles.client.outcomes.find(
      (item) => item.kind === 'log' && item.name === 'payment_failed'
    );
    assert.equal(outcome.count, 1);
    assert.equal(outcome.exemplar.attrs.stack, 'PaymentError: timeout');
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
      executeTool(server.wardx.control, 'set_persist_log', { project: 'demo', name: 'payment_failed' });
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
      executeTool(server.wardx.control, 'delete_persist_log', { project: 'demo', name: 'payment_failed' });
      server.wardx.persistence.mark('logStats');
      await server.wardx.persistence.flush();
      const saved = JSON.parse(readFileSync(logStatsPath(path), 'utf8'));
      assert.deepEqual(saved.projects.demo, {});
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

test('createIngestServer rejects a corrupt log-stats sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(logStatsPath(path), `${JSON.stringify({ nope: true })}\n`);
  try {
    assert.throws(() => createIngestServer(loadServerConfig(path)), /unknown key: nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
