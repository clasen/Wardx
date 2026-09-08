import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createConfiguredMcpHttpServer, createMcpHttpServer } from '../src/mcp/http.js';
import { createIngestServer, listen } from '../src/server.js';
import { testServerConfig } from './helpers.js';

const TOKEN = 'wardx-test-token-with-at-least-32-bytes';

function mcpHttpConfig(overrides = {}) {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    bearerTokenEnvironmentVariable: 'WARDX_TEST_MCP_TOKEN',
    maxRequestBytes: 1024,
    maxConcurrentRequests: 4,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: ['http://127.0.0.1'],
    ...overrides
  };
}

async function withMcpHttp(fn, overrides = {}) {
  const wardx = createIngestServer(testServerConfig());
  const config = mcpHttpConfig(overrides);
  const server = createMcpHttpServer(wardx.wardx.control, config, TOKEN);
  const address = await listen(server, config.port, config.host);
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  try {
    return await fn({ server, url });
  } finally {
    await server.wardxMcp.stop();
    await wardx.wardx.stop();
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

test('Streamable HTTP rejects unauthorized, hostile host/origin, and oversized requests before MCP', async () => {
  await withMcpHttp(async ({ url }) => {
    const unauthorized = await post(url, { token: 'wrong', body: '{' });
    assert.equal(unauthorized.status, 401);

    const hostileHost = await post(url, { host: 'attacker.example' });
    assert.equal(hostileHost.status, 403);

    const hostileOrigin = await post(url, { origin: 'https://attacker.example' });
    assert.equal(hostileOrigin.status, 403);

    const oversized = await post(url, { body: JSON.stringify({ value: 'x'.repeat(2048) }) });
    assert.equal(oversized.status, 413);
  });
});

test('configured Streamable HTTP requires its bearer secret before listening', async () => {
  const wardx = createIngestServer(testServerConfig());
  try {
    assert.throws(
      () => createConfiguredMcpHttpServer(wardx.wardx.control, mcpHttpConfig(), {}),
      /WARDX_TEST_MCP_TOKEN must contain at least 32 bytes/
    );
  } finally {
    await wardx.wardx.stop();
  }
});

test('Streamable HTTP rejects work above its concurrent request bound', async () => {
  await withMcpHttp(async ({ server, url }) => {
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
      await waitFor(() => server.wardxMcp.requestGate.snapshot().active === 1);
      const overloaded = await post(url);
      assert.equal(overloaded.status, 503);
      assert.equal(server.wardxMcp.requestGate.snapshot().rejected, 1);
    } finally {
      held.destroy();
      await waitFor(() => server.wardxMcp.requestGate.snapshot().active === 0);
    }
  }, { maxConcurrentRequests: 1 });
});
