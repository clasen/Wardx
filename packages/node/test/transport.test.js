import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHttpTransport } from '../src/transport/HttpTransport.js';

test('HTTP deadline covers a stalled DNS lookup', async (t) => {
  const request = http.request;
  t.mock.method(http, 'request', (options, callback) => request({
    ...options,
    lookup() {}
  }, callback));
  const transport = createHttpTransport({ endpoint: 'http://offline.test', projectKey: 'test', httpTimeoutMs: 50 });
  const guard = setTimeout(() => transport.close(), 1000);
  try {
    await assert.rejects(transport.post(Buffer.alloc(0)), /wardx sync timed out/);
  } finally {
    clearTimeout(guard);
    transport.close();
  }
});

test('HTTP deadline covers a response that keeps sending without completing', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    res.write(' ');
    const drip = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(drip));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const transport = createHttpTransport({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    projectKey: 'test',
    httpTimeoutMs: 100
  });
  const guard = setTimeout(() => transport.close(), 1000);
  try {
    await assert.rejects(transport.post(Buffer.alloc(0)), /wardx sync timed out/);
  } finally {
    clearTimeout(guard);
    transport.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an interrupted response rejects and the transport can send again', async () => {
  let interrupted = false;
  const server = http.createServer((req, res) => {
    req.resume();
    if (!interrupted) {
      interrupted = true;
      res.writeHead(200, { 'content-length': 100 });
      res.write('{');
      setImmediate(() => res.destroy());
    } else {
      res.end('{"ok":true}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const transport = createHttpTransport({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    projectKey: 'test',
    httpTimeoutMs: 1000
  });
  try {
    await assert.rejects(transport.post(Buffer.alloc(0)), /aborted|socket hang up|ECONNRESET/);
    const result = await transport.post(Buffer.alloc(0));
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, { ok: true });
  } finally {
    transport.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
