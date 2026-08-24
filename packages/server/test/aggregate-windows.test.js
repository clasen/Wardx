import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aggregateWindowsPath, loadAggregateWindows, validateAggregateWindows } from '../src/control/persist.js';
import { loadServerConfig } from '../src/loadConfig.js';
import { executeTool } from '../src/mcp/tools.js';
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

test('validateAggregateWindows rejects unknown keys', () => {
  assert.throws(() => validateAggregateWindows({ extra: 1 }), /unknown key: extra/);
  assert.throws(
    () =>
      validateAggregateWindows({
        projects: {
          demo: [
            {
              from: 0,
              to: 60000,
              frames: 1,
              events: 0,
              logs: 0,
              cardinalityDropped: 0,
              roles: {},
              counters: [],
              gauges: [],
              histograms: [],
              eventNames: [],
              logNames: [],
              experiments: [],
              extra: 1
            }
          ]
        }
      }),
    /unknown key: extra/
  );
});

test('loadAggregateWindows returns empty when the sidecar is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  try {
    const snapshot = loadAggregateWindows(join(dir, 'missing.aggregate-windows.json'));
    assert.deepEqual(snapshot, { projects: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate windows persist across ingest server restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  const now = Date.now();
  try {
    await withServer(loadServerConfig(path), async (server, base) => {
      const res = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-wardx-key': 'test-key'
        },
        body: gzipJson(
          sampleEnvelope({
            configVersion: 12,
            frames: [
              {
                seq: 1,
                from: now,
                to: now + 1,
                metrics: {
                  counters: [['match.completed', { mode: 'ranked' }, 4]],
                  gauges: [['players.online', null, 9, now]],
                  histograms: [
                    [
                      'coins.award_size',
                      { source: 'match' },
                      {
                        count: 1,
                        sum: 80,
                        min: 80,
                        max: 80,
                        buckets: [[50, 1]],
                        exemplar: { value: 80, attrs: { grantId: 'g-80' } }
                      }
                    ]
                  ]
                },
                events: [[now, 'purchase', { product: 'premium' }]],
                logs: []
              }
            ]
          })
        )
      });
      assert.equal(res.status, 200);
      await server.wardx.persistence.flush();
      const saved = JSON.parse(readFileSync(aggregateWindowsPath(path), 'utf8'));
      assert.equal(saved.projects.demo.length, 1);
      assert.equal(saved.projects.demo[0].counters[0].value, 4);
      assert.equal(saved.projects.demo[0].eventNames[0].name, 'purchase');
      assert.equal(saved.projects.demo[0].histograms[0].body.max, 80);
    });
    const restarted = createIngestServer(loadServerConfig(path));
    const windows = executeTool(restarted.wardx.control, 'get_aggregates', { project: 'demo' });
    assert.equal(windows.windows.length, 1);
    assert.equal(windows.windows[0].counters[0].value, 4);
    assert.equal(windows.windows[0].gauges[0].value, 9);
    assert.equal(windows.windows[0].eventNames[0].count, 1);
    assert.equal(windows.windows[0].histograms[0].body.max, 80);
    assert.deepEqual(windows.windows[0].histograms[0].body.exemplar, {
      value: 80,
      attrs: { grantId: 'g-80' }
    });
    const overview = executeTool(restarted.wardx.control, 'get_project_overview', { project: 'demo' });
    const sent = overview.roles.client.outcomes.find(
      (row) => row.kind === 'counter' && row.name === 'match.completed'
    );
    assert.equal(sent.value, 4);
    const peak = overview.roles.client.outcomes.find(
      (row) => row.kind === 'histogram' && row.name === 'coins.award_size'
    );
    assert.equal(peak.max, 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hydrateAggregateWindows drops windows older than retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  const freshFrom = Math.floor(Date.now() / 60000) * 60000;
  const staleFrom = freshFrom - 120 * 60000;
  const emptyWindow = (from) => ({
    from,
    to: from + 60000,
    frames: 1,
    events: 0,
    logs: 0,
    cardinalityDropped: 0,
    roles: { client: { frames: 1, events: 0, logs: 0 } },
    counters: [{ name: 'n', dims: null, role: 'client', value: from === staleFrom ? 1 : 9 }],
    gauges: [],
    histograms: [],
    eventNames: [],
    logNames: [],
    experiments: []
  });
  writeFileSync(
    aggregateWindowsPath(path),
    `${JSON.stringify({ projects: { demo: [emptyWindow(staleFrom), emptyWindow(freshFrom)] } }, null, 2)}\n`
  );
  try {
    const server = createIngestServer(loadServerConfig(path));
    const windows = executeTool(server.wardx.control, 'get_aggregates', { project: 'demo' });
    assert.equal(windows.windows.length, 1);
    assert.equal(windows.windows[0].from, freshFrom);
    assert.equal(windows.windows[0].counters[0].value, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer rejects a corrupt aggregate-windows sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(aggregateWindowsPath(path), `${JSON.stringify({ nope: true })}\n`);
  try {
    assert.throws(() => createIngestServer(loadServerConfig(path)), /unknown key: nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer rejects truncated aggregate-windows JSON without replacing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  const sidecar = aggregateWindowsPath(path);
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(sidecar, '{"projects":');
  try {
    assert.throws(() => createIngestServer(loadServerConfig(path)), /Unexpected end of JSON input/);
    assert.equal(readFileSync(sidecar, 'utf8'), '{"projects":');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
