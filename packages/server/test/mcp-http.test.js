import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createIngestServer, listen } from '../src/server.js';
import { testServerConfig } from './helpers.js';

const TOKEN = 'wardx-test-token-with-at-least-32-bytes';
process.env.WARDX_TEST_MCP_TOKEN = TOKEN;

function mcpHttpConfig(overrides = {}) {
  return {
    enabled: true,
    path: '/mcp',
    bearerTokenEnvironmentVariable: 'WARDX_TEST_MCP_TOKEN',
    maxRequestBytes: 1024,
    maxConcurrentRequests: 4,
    bodyTimeoutMs: 30000,
    ...overrides
  };
}

async function withMcpHttp(fn, overrides = {}) {
  const server = createIngestServer(testServerConfig({ mcpHttp: mcpHttpConfig(overrides) }));
  const address = await listen(server, 0, '127.0.0.1');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  try {
    return await fn({ mcp: server.wardx.mcpHttp, url });
  } finally {
    await server.wardx.stop();
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function post(url, { token = TOKEN, host, origin, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(host ? { host } : {}),
        ...(origin ? { origin } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('Streamable HTTP authenticates one bearer credential and exposes Wardx tools', async () => {
  await withMcpHttp(async ({ url }) => {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
    });
    const client = new Client({ name: 'wardx-http-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.find((tool) => tool.name === 'list_projects').annotations?.readOnlyHint, true);
      assert.notEqual(tools.tools.find((tool) => tool.name === 'set_config_value').annotations?.readOnlyHint, true);
      assert.notEqual(tools.tools.find((tool) => tool.name === 'analyze_experiment').annotations?.readOnlyHint, true);
      const result = await client.callTool({ name: 'list_projects', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), { projects: ['demo'] });
    } finally {
      await client.close();
    }
  });
});

test('Streamable HTTP rejects unauthorized and oversized requests before MCP', async () => {
  await withMcpHttp(async ({ url }) => {
    const unauthorized = await post(url, { token: 'wrong', body: '{' });
    assert.equal(unauthorized.status, 401);

    const oversized = await post(url, { body: JSON.stringify({ value: 'x'.repeat(2048) }) });
    assert.equal(oversized.status, 413);
  });
});

test('Streamable HTTP authorizes by bearer token regardless of Host or Origin', async () => {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'wardx-proxy-test', version: '1.0.0' }
    }
  });
  await withMcpHttp(async ({ url }) => {
    const authorized = await post(url, {
      host: 'wardx.example',
      origin: 'https://wardx.example',
      body: initialize
    });
    assert.equal(authorized.status, 200);

    const unauthorized = await post(url, {
      host: 'wardx.example',
      origin: 'https://wardx.example',
      token: 'wrong',
      body: initialize
    });
    assert.equal(unauthorized.status, 401);
  });
});

test('Streamable HTTP shares the ingest port without changing ingest routes', async () => {
  await withMcpHttp(async ({ url }) => {
    const health = await fetch(new URL('/health', url));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const unauthorized = await post(url, { token: 'wrong' });
    assert.equal(unauthorized.status, 401);
  });
});

test('configured Streamable HTTP requires its bearer secret before opening state', () => {
  assert.throws(
    () => createIngestServer(testServerConfig({
      mcpHttp: mcpHttpConfig({ bearerTokenEnvironmentVariable: 'WARDX_TEST_MISSING_MCP_TOKEN' })
    })),
    /WARDX_TEST_MISSING_MCP_TOKEN must contain at least 32 bytes/
  );
});

test('Streamable HTTP rejects work above its concurrent request bound', async () => {
  await withMcpHttp(async ({ mcp, url }) => {
    const held = request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      }
    });
    held.on('error', () => {});
    held.write('{');
    try {
      await waitFor(() => mcp.requestGate.snapshot().active === 1);
      const overloaded = await post(url);
      assert.equal(overloaded.status, 503);
      assert.equal(mcp.requestGate.snapshot().rejected, 1);
    } finally {
      held.destroy();
      await waitFor(() => mcp.requestGate.snapshot().active === 0);
    }
  }, { maxConcurrentRequests: 1 });
});

test('Streamable HTTP refuses standalone SSE streams so they cannot hold request slots', async () => {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'wardx-sse-test', version: '1.0.0' }
    }
  });
  await withMcpHttp(async ({ mcp, url }) => {
    const aborter = new AbortController();
    try {
      const stream = await fetch(url, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` },
        signal: aborter.signal
      });
      assert.equal(stream.status, 405);
      assert.equal(stream.headers.get('allow'), 'POST, DELETE');
      assert.equal(mcp.requestGate.snapshot().active, 0);
      assert.equal((await post(url, { body: initialize })).status, 200);
    } finally {
      aborter.abort();
    }
  }, { maxConcurrentRequests: 1 });
});

test('Streamable HTTP releases the slot held by a stalled request body', async () => {
  await withMcpHttp(async ({ mcp, url }) => {
    const stalled = request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      }
    });
    stalled.on('error', () => {});
    stalled.write('{');
    try {
      await waitFor(() => mcp.requestGate.snapshot().active === 1);
      await waitFor(() => mcp.requestGate.snapshot().active === 0);
      assert.notEqual((await post(url)).status, 503);
    } finally {
      stalled.destroy();
    }
  }, { maxConcurrentRequests: 1, bodyTimeoutMs: 100 });
});
