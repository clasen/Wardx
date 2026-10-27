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

const SCOPED_TOKEN = 'wardx-scoped-test-token-with-at-least-32-bytes';
const EMPTY_PROJECT = { version: 1, values: {}, keyRoles: {}, experiments: [] };

function twoProjectConfig(mcpOverrides) {
  const config = testServerConfig({ mcpHttp: mcpHttpConfig(mcpOverrides) });
  config.projects.other = structuredClone(EMPTY_PROJECT);
  return config;
}

async function withMcpHttp(fn, overrides = {}, configure = (mcpOverrides) => testServerConfig({ mcpHttp: mcpHttpConfig(mcpOverrides) })) {
  const server = createIngestServer(configure(overrides));
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

async function connect(url, token) {
  const client = new Client({ name: 'wardx-scope-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  }));
  return client;
}

test('a project-scoped token sees and reaches only its projects while the top-level token sees all', async () => {
  const tokens = [{ name: 'demo-agent', projects: ['demo'], bearerToken: SCOPED_TOKEN }];
  await withMcpHttp(async ({ url }) => {
    const scoped = await connect(url, SCOPED_TOKEN);
    const admin = await connect(url, TOKEN);
    try {
      const listed = await scoped.callTool({ name: 'list_projects', arguments: {} });
      assert.deepEqual(JSON.parse(listed.content[0].text), { projects: ['demo'] });
      const resources = await scoped.listResources();
      assert.deepEqual(resources.resources.map((resource) => resource.name), ['demo']);
      const own = await scoped.callTool({ name: 'get_config', arguments: { project: 'demo' } });
      assert.equal(own.isError, undefined);

      const hidden = await scoped.callTool({ name: 'get_config', arguments: { project: 'other' } });
      const missing = await scoped.callTool({ name: 'get_config', arguments: { project: 'absent' } });
      assert.equal(hidden.isError, true);
      assert.match(hidden.content[0].text, /unknown project: other/);
      assert.equal(missing.content[0].text.replace('absent', 'other'), hidden.content[0].text);
      const mutation = await scoped.callTool({
        name: 'set_project_description',
        arguments: { project: 'other', description: 'x', expectedVersion: 1, reason: 'scope test' }
      });
      assert.equal(mutation.isError, true);
      await assert.rejects(scoped.readResource({ uri: 'wardx://project/other' }), /unknown project: other/);

      const all = await admin.callTool({ name: 'list_projects', arguments: {} });
      assert.deepEqual(JSON.parse(all.content[0].text), { projects: ['demo', 'other'] });
      const adminOther = await admin.callTool({ name: 'get_config', arguments: { project: 'other' } });
      assert.equal(adminOther.isError, undefined);
    } finally {
      await scoped.close();
      await admin.close();
    }
  }, { tokens }, twoProjectConfig);
});

test('project-scoped tokens read their environment variable and must be distinct', () => {
  process.env.WARDX_TEST_SCOPED_MCP_TOKEN = SCOPED_TOKEN;
  const fromEnvironment = twoProjectConfig({
    tokens: [{ name: 'demo-agent', projects: ['demo'], bearerTokenEnvironmentVariable: 'WARDX_TEST_SCOPED_MCP_TOKEN' }]
  });
  const server = createIngestServer(fromEnvironment);
  return server.wardx.stop().then(() => {
    assert.throws(
      () => createIngestServer(twoProjectConfig({
        tokens: [{ name: 'demo-agent', projects: ['demo'], bearerTokenEnvironmentVariable: 'WARDX_TEST_MISSING_MCP_TOKEN' }]
      })),
      /WARDX_TEST_MISSING_MCP_TOKEN must contain at least 32 bytes/
    );
    assert.throws(
      () => createIngestServer(twoProjectConfig({
        tokens: [{ name: 'demo-agent', projects: ['demo'], bearerToken: TOKEN }]
      })),
      /MCP bearer tokens must be distinct/
    );
  });
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
