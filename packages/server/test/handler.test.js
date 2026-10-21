import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWardxHandler, createIngestServer, startServer, listen } from '../src/index.js';
import { sampleEnvelope, testServerConfig } from './helpers.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('handler uses an external transport without ingest listen or process signals', async (t) => {
  const external = http.createServer();
  const address = await listen(external, 0, '127.0.0.1');
  t.after(() => close(external));
  const signals = ['SIGINT', 'SIGTERM'].map((signal) => process.listeners(signal));
  const config = testServerConfig({ port: address.port });
  const runtime = await createWardxHandler(config);
  t.after(() => runtime.stop());
  external.on('request', runtime.handler);
  assert.deepEqual(runtime.config, config);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map((signal) => process.listeners(signal)), signals);
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  const response = await fetch(`${base}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wardx-key': 'test-key' },
    body: JSON.stringify(sampleEnvelope())
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configVersion, 12);
  const stopped = runtime.stop();
  assert.equal(runtime.stop(), stopped);
  await stopped;
  assert.equal(external.listening, true);
  const readiness = await fetch(`${base}/ready`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).checks.running, false);
  assert.equal((await fetch(`${base}/v1/sync`, { method: 'POST', body: '{}' })).status, 503);
});

test('handler stop drains an accepted streaming request and persists it before resolving', async (t) => {
  const config = testServerConfig();
  const runtime = await createWardxHandler(config);
  const accepted = deferred();
  const external = http.createServer((req, res) => {
    runtime.handler(req, res);
    accepted.resolve();
  });
  const address = await listen(external, 0, '127.0.0.1');
  t.after(async () => { await close(external); await runtime.stop(); });
  const body = JSON.stringify(sampleEnvelope());
  const result = deferred();
  const request = http.request(`http://127.0.0.1:${address.port}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wardx-key': 'test-key' }
  }, (response) => {
    response.resume();
    response.on('end', () => result.resolve(response.statusCode));
  });
  request.on('error', result.reject);
  t.after(() => request.destroy());
  request.write(body.slice(0, 10));
  await accepted.promise;
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  const rejected = await fetch(`http://127.0.0.1:${address.port}/v1/sync`, { method: 'POST', body: '{}' });
  assert.equal(rejected.status, 503);
  request.end(body.slice(10));
  assert.equal(await result.promise, 200);
  await stopping;
  const restored = createIngestServer(config);
  t.after(() => restored.wardx.stop());
  const buckets = restored.wardx.stateStore.readBuckets({ project: 'demo', tier: 'minute', from: Date.now() - 120_000, to: Date.now() + 60_000 });
  assert.equal(buckets.flatMap((bucket) => bucket.rows).find((row) => row.name === 'match.completed').value, 4);
});

test('handler releases the sync slot held by a stalled request body', async (t) => {
  const runtime = await createWardxHandler(testServerConfig({
    capacity: { maxConcurrentSyncHandlers: 1, syncBodyTimeoutMs: 100 }
  }));
  const external = http.createServer(runtime.handler);
  const address = await listen(external, 0, '127.0.0.1');
  t.after(async () => { external.closeAllConnections(); await close(external); await runtime.stop(); });
  const stalled = net.connect(address.port, '127.0.0.1');
  stalled.on('error', () => {});
  t.after(() => stalled.destroy());
  const closed = new Promise((resolve) => stalled.once('close', resolve));
  stalled.write([
    'POST /v1/sync HTTP/1.1', 'Host: 127.0.0.1', 'x-wardx-key: test-key',
    'content-type: application/json', 'content-length: 100', '', '{"protocol":'
  ].join('\r\n'));
  const sync = () => fetch(`http://127.0.0.1:${address.port}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wardx-key': 'test-key' },
    body: JSON.stringify(sampleEnvelope())
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await sync()).status, 503);
  await closed;
  assert.equal((await sync()).status, 200);
});

function mcpConfig() {
  return {
    enabled: true, path: '/mcp',
    bearerTokenEnvironmentVariable: 'WARDX_HANDLER_TEST_TOKEN',
    maxRequestBytes: 4096, maxConcurrentRequests: 4, bodyTimeoutMs: 30000
  };
}

function setToken(t) {
  const name = 'WARDX_HANDLER_TEST_TOKEN';
  const previous = process.env[name];
  const token = 'wardx-handler-test-token-at-least-32-bytes';
  process.env[name] = token;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  return token;
}

test('handler serves authenticated MCP on the external transport and stops idempotently', async (t) => {
  const token = setToken(t);
  const runtime = await createWardxHandler(testServerConfig({ mcpHttp: mcpConfig() }));
  t.after(() => runtime.stop());
  const external = http.createServer(runtime.handler);
  const address = await listen(external, 0, '127.0.0.1');
  t.after(() => close(external));
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  const client = new Client({ name: 'handler-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  }));
  const result = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { projects: ['demo'] });
  await client.close();
  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping);
  await stopping;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 503);
});

test('handler rejects a missing MCP token before opening state and can be initialized again', async (t) => {
  const config = testServerConfig({ mcpHttp: mcpConfig() });
  const name = config.mcpHttp.bearerTokenEnvironmentVariable;
  const previous = process.env[name];
  delete process.env[name];
  t.after(() => {
    if (previous !== undefined) process.env[name] = previous;
  });
  await assert.rejects(createWardxHandler(config), /must contain at least 32 bytes/);
  await assert.rejects(startServer(config), /must contain at least 32 bytes/);
  setToken(t);
  const runtime = await createWardxHandler(config);
  await runtime.stop();
});
