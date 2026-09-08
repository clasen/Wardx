import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HyperLogLog } from '@wardx/core';
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

test('restart hydrates only mutable minute state and preserves accepted late totals', async (t) => {
  const now = Date.UTC(2026, 7, 20, 12, 30);
  t.mock.method(Date, 'now', () => now);
  const directory = mkdtempSync(join(tmpdir(), 'wardx-hydrate-'));
  const config = testServerConfig();
  config.sqlite.path = join(directory, 'state.sqlite');
  config.history.clockSkewAllowanceMs = 1;
  const old = now - 70 * 60_000;
  const recent = now - 30 * 60_000;
  let server = createIngestServer(config);
  const row = {
    kind: 'counter', name: 'requests', role: 'client', environment: 'test', appVersion: '0.0.0',
    dimensions: null, value: 4
  };
  try {
    server.wardx.stateStore.saveBuckets('minute', [old, recent].map((from) => ({
      project: 'demo', tier: 'minute', from, to: from + 60_000, finalized: true, dropCount: 0, rows: [row]
    })));
    await server.wardx.stop();
    server = createIngestServer(config);
    assert.ok(server.wardx.stateStore.readBucket('demo', 'minute', old));
    const history = server.wardx.registry.get('demo').history;
    assert.equal(history.states.has(old), false);
    assert.equal(history.states.has(recent), true);
    const envelope = sampleEnvelope();
    envelope.frames[0].from = recent;
    envelope.frames[0].metrics.counters = [['requests', null, 3]];
    history.ingest(envelope, []);
    server.wardx.persistence.mark('history');
    await server.wardx.persistence.flush();
    assert.equal(server.wardx.stateStore.readBucket('demo', 'minute', recent).rows.find((entry) => entry.name === 'requests').value, 7);
  } finally {
    await server.wardx.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('historical aggregate buckets persist across ingest server restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  const config = testServerConfig({ port: 0 });
  config.history.clockSkewAllowanceMs = 1;
  config.history.maxAcceptedPastAgeMs = 3_600_000;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const now = Date.now() - 600_000;
  const hourFrom = Math.floor(now / 3_600_000) * 3_600_000;
  const hll = new HyperLogLog('shot.traffic.hids', null, 'test-salt');
  hll.add('private-hid-a');
  hll.add('private-hid-b');
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
                  ],
                  distincts: [['shot.traffic.hids', { result: 'violating' }, hll.snapshot()]]
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
      assert.equal(existsSync(aggregateWindowsPath(path)), false);
    });
    const restarted = createIngestServer(loadServerConfig(path));
    const history = executeTool(restarted.wardx.control, 'get_aggregate_history', {
      project: 'demo',
      tier: 'hour',
      from: hourFrom,
      to: hourFrom + 3_600_000
    });
    assert.equal(history.buckets.length, 1);
    assert.equal(history.buckets[0].rows.find((row) => row.name === 'match.completed').value, 4);
    const histogram = history.buckets[0].rows.find((row) => row.name === 'coins.award_size');
    assert.equal(histogram.max, 80);
    assert.equal(histogram.exemplar, undefined);
    const distinct = history.buckets[0].rows.find((row) => row.name === 'shot.traffic.hids');
    assert.ok(distinct.estimate >= 1 && distinct.estimate <= 3);
    assert.equal(distinct.precision, 9);
    assert.equal(distinct.registers, undefined);
    const event = history.buckets[0].rows.find((row) => row.name === 'purchase');
    assert.equal(event.attrs, undefined);
    assert.equal(event.instanceId, undefined);
    assert.doesNotMatch(JSON.stringify(history), /private-hid-a|private-hid-b/);
    assert.equal(executeTool(restarted.wardx.control, 'get_aggregates', { project: 'demo' }).windows.length, 0);
    assert.deepEqual(executeTool(restarted.wardx.control, 'get_recent_events', { project: 'demo' }).events, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer ignores obsolete aggregate-window sidecars', () => {
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
    assert.deepEqual(executeTool(server.wardx.control, 'get_aggregates', { project: 'demo' }).windows, []);
    server.wardx.stateStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer ignores a corrupt obsolete aggregate-windows sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(aggregateWindowsPath(path), `${JSON.stringify({ nope: true })}\n`);
  try {
    const server = createIngestServer(loadServerConfig(path));
    server.wardx.stateStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer ignores truncated obsolete aggregate-windows JSON without replacing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  const sidecar = aggregateWindowsPath(path);
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(sidecar, '{"projects":');
  try {
    const server = createIngestServer(loadServerConfig(path));
    server.wardx.stateStore.close();
    assert.equal(readFileSync(sidecar, 'utf8'), '{"projects":');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
