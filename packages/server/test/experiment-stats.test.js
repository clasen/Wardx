import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { experimentStatsPath, loadExperimentStats, validateExperimentStats } from '../src/control/persist.js';
import { loadServerConfig } from '../src/loadConfig.js';
import { createIngestServer, listen } from '../src/server.js';
import { gzipJson, sampleEnvelope, testServerConfig } from './helpers.js';

const DELAY_EXPERIMENT = {
  id: 'delay',
  enabled: true,
  allocation: 1,
  salt: 'delay-salt',
  primaryMetric: 'message.sent',
  goalMetric: 'message.sent',
  roles: ['client'],
  variants: [
    { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
    { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
  ]
};

function experimentServerConfig(overrides = {}) {
  const config = testServerConfig(overrides);
  config.projects.demo.experiments = [DELAY_EXPERIMENT];
  return config;
}

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

function experimentEnvelope(now = Date.now()) {
  return sampleEnvelope({
    configVersion: 12,
    frames: [
      {
        seq: 1,
        from: now,
        to: now + 1,
        metrics: { counters: [], gauges: [], histograms: [] },
        events: [
          [now, 'experiment.exposure', { experiment: 'delay', variant: 'fast', subject: 'subject-hash' }],
          [
            now,
            'experiment.goal',
            {
              metric: 'message.sent',
              subject: 'subject-hash',
              experiments: [{ experiment: 'delay', variant: 'fast' }],
              value: 4
            }
          ]
        ],
        logs: []
      }
    ]
  });
}

test('validateExperimentStats rejects unknown keys', () => {
  assert.throws(() => validateExperimentStats({ extra: 1 }), /unknown key: extra/);
  assert.throws(
    () =>
      validateExperimentStats({
        projects: { demo: { delay: { fast: { exposures: 1, goals: 1, goalSum: 1, goalSumSq: 1, extra: 1 } } } }
      }),
    /unknown key: extra/
  );
});

test('loadExperimentStats returns empty when the sidecar is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  try {
    const snapshot = loadExperimentStats(join(dir, 'missing.experiment-stats.json'));
    assert.deepEqual(snapshot, { projects: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('experiment lifetime stats persist across ingest server restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(experimentServerConfig({ port: 0 }), null, 2)}\n`);
  try {
    const first = loadServerConfig(path);
    await withServer(first, async (server, base) => {
      const res = await fetch(`${base}/v1/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-wardx-key': 'test-key'
        },
        body: gzipJson(experimentEnvelope())
      });
      assert.equal(res.status, 200);
      await server.wardx.persistence.flush();
      const saved = JSON.parse(readFileSync(experimentStatsPath(path), 'utf8'));
      assert.equal(saved.projects.demo.delay.fast.exposures, 1);
      assert.equal(saved.projects.demo.delay.fast.goals, 1);
      assert.equal(saved.projects.demo.delay.fast.goalSum, 4);
      assert.equal(saved.projects.demo.delay.fast.goalSumSq, 16);
    });
    const second = loadServerConfig(path);
    const restarted = createIngestServer(second);
    const row = restarted.wardx.control.analyzeExperiment('demo', 'delay').variants.find((item) => item.key === 'fast');
    assert.equal(row.exposures, 1);
    assert.equal(row.goals, 1);
    assert.equal(row.goalSum, 4);
    assert.equal(row.goalMean, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metric-only sync does not create an experiment-stats sidecar', async () => {
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
        body: gzipJson(sampleEnvelope({ configVersion: 12 }))
      });
      assert.equal(res.status, 200);
    });
    assert.equal(existsSync(experimentStatsPath(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createIngestServer rejects a corrupt experiment-stats sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wardx-'));
  const path = join(dir, 'server.json');
  writeFileSync(path, `${JSON.stringify(testServerConfig({ port: 0 }), null, 2)}\n`);
  writeFileSync(experimentStatsPath(path), `${JSON.stringify({ nope: true })}\n`);
  try {
    assert.throws(() => createIngestServer(loadServerConfig(path)), /unknown key: nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
