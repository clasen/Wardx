import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ReadinessMonitor, validateMonitorConfig } from '../src/ops/monitor.js';

async function fixture(t, overrides = {}) {
  const state = { ready: true, checks: null, body: null, readyStatus: null, webhookStatus: 204, hang: null, redirect: false };
  const notifications = [];
  let checks = 0;
  let redirected = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/ready') {
      checks += 1;
      if (state.hang === 'headers') return;
      res.writeHead(state.readyStatus ?? (state.ready ? 200 : 503), { 'content-type': 'application/json' });
      if (state.hang === 'body') {
        res.write('{');
        return;
      }
      res.end(state.body ?? JSON.stringify({ ok: state.ready, checks: state.checks ?? { sqlite: state.ready } }));
      return;
    }
    if (req.url === '/redirected') redirected += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    notifications.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    state.onNotification?.(notifications.at(-1));
    if (state.hang === 'webhook') return;
    if (state.redirect) {
      res.writeHead(307, { location: '/redirected' });
      res.end();
      return;
    }
    res.writeHead(state.webhookStatus);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = {
    endpoint: `${base}/ready`, intervalMs: 10, requestTimeoutMs: 300,
    maxResponseBytes: 1024, failureThreshold: 2, recoveryThreshold: 2,
    webhookUrlEnvironmentVariable: 'WARDX_TEST_WEBHOOK', webhookTimeoutMs: 300,
    ...overrides
  };
  const environment = { WARDX_TEST_WEBHOOK: `${base}/webhook?token=private-test-token` };
  const monitor = new ReadinessMonitor(config, environment);
  t.after(() => monitor.close());
  return { config, environment, monitor, state, notifications, checks: () => checks, redirected: () => redirected };
}

test('readiness monitor is quiet initially and debounces, deduplicates and recovers', async (t) => {
  const { monitor, state, notifications } = await fixture(t);
  await monitor.check();
  await monitor.check();
  assert.deepEqual(notifications, []);
  state.ready = false;
  await monitor.check();
  state.ready = true;
  await monitor.check();
  state.ready = false;
  await monitor.check();
  assert.deepEqual(notifications, []);
  assert.deepEqual(await monitor.check(), { status: 'degraded', notification: 'sent' });
  await monitor.check();
  state.ready = true;
  await monitor.check();
  assert.equal(notifications.length, 1);
  assert.deepEqual(await monitor.check(), { status: 'healthy', notification: 'sent' });
  await monitor.check();
  assert.deepEqual(notifications, [
    { type: 'wardx.readiness', status: 'degraded' },
    { type: 'wardx.readiness', status: 'recovered' }
  ]);
});

test('readiness monitor retries failed webhook delivery and discards obsolete pending state', async (t) => {
  const { monitor, state, notifications } = await fixture(t, { failureThreshold: 1, recoveryThreshold: 1 });
  state.ready = false;
  state.webhookStatus = 500;
  assert.equal((await monitor.check()).notification, 'failed');
  assert.equal(monitor.deliveredStatus, 'healthy');
  state.ready = true;
  assert.equal((await monitor.check()).notification, 'none');
  assert.equal(notifications.length, 1);
  state.ready = false;
  assert.equal((await monitor.check()).notification, 'failed');
  state.webhookStatus = 204;
  assert.equal((await monitor.check()).notification, 'sent');
  assert.equal((await monitor.check()).notification, 'none');
  state.ready = true;
  state.webhookStatus = 500;
  assert.equal((await monitor.check()).notification, 'failed');
  state.webhookStatus = 204;
  assert.equal((await monitor.check()).notification, 'sent');
  assert.deepEqual(notifications.map((value) => value.status), ['degraded', 'degraded', 'degraded', 'recovered', 'recovered']);
});

test('readiness monitor rejects malformed, inconsistent and oversized responses', async (t) => {
  const invalid = [
    { body: 'not json' },
    { body: JSON.stringify({ ok: true, checks: {} }) },
    { body: JSON.stringify({ ok: true, checks: { sqlite: 'true' } }) },
    { checks: { sqlite: false } },
    { readyStatus: 503 },
    { readyStatus: 201 },
    { body: ' '.repeat(1025) }
  ];
  for (const input of invalid) {
    await t.test(JSON.stringify(input).slice(0, 90), async (t) => {
      const { monitor, state } = await fixture(t, { failureThreshold: 1 });
      Object.assign(state, input);
      assert.equal((await monitor.check()).status, 'degraded');
    });
  }
});

test('readiness deadlines cover headers and streaming response body', async (t) => {
  for (const hang of ['headers', 'body']) {
    await t.test(hang, { timeout: 2000 }, async (t) => {
      const { monitor, state } = await fixture(t, { failureThreshold: 1, requestTimeoutMs: 30 });
      state.hang = hang;
      assert.deepEqual(await monitor.check(), { status: 'degraded', notification: 'sent' });
    });
  }
});

test('webhook timeout is retried next cycle and redirects are never followed', { timeout: 3000 }, async (t) => {
  const { monitor, state, redirected } = await fixture(t, { failureThreshold: 1, webhookTimeoutMs: 30 });
  state.ready = false;
  state.hang = 'webhook';
  assert.equal((await monitor.check()).notification, 'failed');
  state.hang = null;
  state.redirect = true;
  assert.equal((await monitor.check()).notification, 'failed');
  assert.equal(redirected(), 0);
  state.redirect = false;
  assert.equal((await monitor.check()).notification, 'sent');
});

test('concurrent checks share one probe and shutdown aborts an outstanding request without alerting', async (t) => {
  const { monitor, state, checks, notifications } = await fixture(t);
  await Promise.all([monitor.check(), monitor.check(), monitor.check()]);
  assert.equal(checks(), 1);
  state.hang = 'headers';
  const pending = monitor.check();
  await monitor.close();
  await pending;
  assert.deepEqual(notifications, []);
  await assert.rejects(monitor.check(), /closed/);
});

test('monitor config is closed, complete, bounded and does not leak invalid URLs', async (t) => {
  const { config } = await fixture(t);
  for (const key of Object.keys(config)) {
    const missing = { ...config };
    delete missing[key];
    assert.throws(() => validateMonitorConfig(missing), /requires/);
  }
  assert.throws(() => validateMonitorConfig({ ...config, unknown: true }), /unknown/);
  for (const key of ['intervalMs', 'requestTimeoutMs', 'maxResponseBytes', 'failureThreshold', 'recoveryThreshold', 'webhookTimeoutMs']) {
    assert.throws(() => validateMonitorConfig({ ...config, [key]: 0 }), /positive/);
  }
  assert.throws(() => validateMonitorConfig({ ...config, intervalMs: 2 ** 31 }), /timer range/);
  assert.throws(() => validateMonitorConfig({ ...config, endpoint: 'https://user:secret@example.com/ready' }), (error) => !error.message.includes('secret'));
  assert.throws(() => new ReadinessMonitor(config, {}), /webhook URL/);
});

test('monitor CLI startup errors never echo config, URLs or credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wardx-monitor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  await writeFile(path, '{secret-credential-with-invalid-json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/ops/monitor-cli.js', import.meta.url)), path], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  const text = Buffer.concat(output).toString('utf8');
  assert.match(text, /could not start/);
  assert.ok(!text.includes('secret-credential'));
  assert.ok(!text.includes(path));
});

test('monitor CLI polls independently, sends transitions and stops cleanly', { timeout: 3000 }, async (t) => {
  const { config, environment, state, notifications, checks } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'wardx-monitor-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config));
  state.ready = false;
  const recovered = new Promise((resolve) => {
    state.onNotification = (notification) => {
      if (notification.status === 'degraded') state.ready = true;
      if (notification.status === 'recovered') resolve();
    };
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/ops/monitor-cli.js', import.meta.url)), path], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment }
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'close');
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  await recovered;
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(checks() >= 4);
  assert.deepEqual(notifications.map((value) => value.status), ['degraded', 'recovered']);
  assert.equal(Buffer.concat(output).toString('utf8'), '');
});

test('monitor CLI reports webhook failure and delivery recovery once without leaking URLs', { timeout: 3000 }, async (t) => {
  const { config, environment, state, notifications } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'wardx-monitor-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config));
  state.ready = false;
  state.webhookStatus = 500;
  state.onNotification = () => {
    if (notifications.length === 3) state.webhookStatus = 204;
  };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/ops/monitor-cli.js', import.meta.url)), path], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment }
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'close');
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  await new Promise((resolve) => {
    child.stderr.on('data', (chunk) => {
      output.push(chunk);
      if (Buffer.concat(output).toString('utf8').includes('delivery recovered')) resolve();
    });
  });
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(notifications.length, 3);
  assert.equal(Buffer.concat(output).toString('utf8'),
    'Wardx readiness monitor webhook delivery failed.\nWardx readiness monitor webhook delivery recovered.\n');
});
