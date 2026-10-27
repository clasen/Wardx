import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConcurrencyGate } from '../capacity/ConcurrencyGate.js';
import { BodyTimeoutError, PayloadTooLargeError, readBody } from '../ingest/readBody.js';
import { createMcpServer } from './stdio.js';

function jsonRpcError(res, status, message, headers = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null
  });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function matches(actual, expectedToken) {
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compares against every grant so the response time does not reveal which one matched.
function authorize(header, grants) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const actual = Buffer.from(header.slice('Bearer '.length), 'utf8');
  let granted = null;
  for (const grant of grants) {
    if (matches(actual, grant.token)) granted = grant;
  }
  return granted;
}

function readEnvironmentToken(name, environment) {
  const token = environment[name];
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error(`MCP bearer token environment variable ${name} must contain at least 32 bytes`);
  }
  return token;
}

// The top-level token sees every project; each entry in config.tokens sees only its projects.
export function readMcpGrants(config, environment = process.env) {
  const grants = [{
    name: null,
    projects: null,
    token: config.bearerToken ?? readEnvironmentToken(config.bearerTokenEnvironmentVariable, environment)
  }];
  for (const scoped of config.tokens ?? []) {
    grants.push({
      name: scoped.name,
      projects: scoped.projects,
      token: scoped.bearerToken ?? readEnvironmentToken(scoped.bearerTokenEnvironmentVariable, environment)
    });
  }
  if (new Set(grants.map((grant) => grant.token)).size !== grants.length) {
    throw new Error('MCP bearer tokens must be distinct');
  }
  return grants;
}

export function createMcpHttpHandler(control, config, grants) {
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new Error('MCP HTTP needs at least one bearer token');
  }
  for (const grant of grants) {
    if (typeof grant.token !== 'string' || Buffer.byteLength(grant.token) < 32) {
      throw new Error('MCP bearer token must contain at least 32 bytes');
    }
  }
  const requestGate = new ConcurrencyGate(config.maxConcurrentRequests);
  const activeConnections = new Set();
  let stopping = false;
  let stopPromise = null;

  async function serve(req, res) {
    const grant = authorize(req.headers.authorization, grants);
    if (!grant) {
      jsonRpcError(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
      return;
    }
    if (req.method === 'GET') {
      jsonRpcError(res, 405, 'Method not allowed', { allow: 'POST, DELETE' });
      return;
    }
    if (stopping) {
      jsonRpcError(res, 503, 'Server shutting down');
      return;
    }
    const leave = requestGate.enter();
    if (!leave) {
      jsonRpcError(res, 503, 'Overloaded');
      return;
    }
    try {
      let parsedBody;
      if (req.method === 'POST') {
        const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
        if (encoding !== '' && encoding !== 'identity') {
          jsonRpcError(res, 415, 'Unsupported content encoding');
          return;
        }
        let raw;
        const bodyTimer = setTimeout(() => req.destroy(new BodyTimeoutError()), config.bodyTimeoutMs);
        try {
          raw = await readBody(req, config.maxRequestBytes);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            jsonRpcError(res, 413, 'Payload too large');
            return;
          }
          if (error instanceof BodyTimeoutError) {
            control.diagnostics.report('mcp.http_body_timeout', error, { method: req.method });
            return;
          }
          throw error;
        } finally {
          clearTimeout(bodyTimer);
        }
        try {
          parsedBody = JSON.parse(raw.toString('utf8'));
        } catch {
          jsonRpcError(res, 400, 'Invalid JSON');
          return;
        }
      }

      const mcp = createMcpServer(control, grant.projects);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      let cleanupPromise = null;
      const connection = {
        close() {
          if (!cleanupPromise) {
            cleanupPromise = mcp.close().finally(() => {
              activeConnections.delete(connection);
            });
          }
          return cleanupPromise;
        }
      };
      activeConnections.add(connection);
      res.once('close', () => void connection.close());
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } finally {
        await connection.close();
      }
    } finally {
      leave();
    }
  }

  async function handle(req, res) {
    try {
      await serve(req, res);
    } catch (error) {
      control.diagnostics.report('mcp.http_unexpected', error, { method: req.method });
      jsonRpcError(res, 500, 'Internal server error');
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = Promise.all([...activeConnections].map((connection) => connection.close())).then(() => {});
    return stopPromise;
  }

  return {
    config,
    requestGate,
    handle,
    stop,
    isReady: () => {
      const capacity = requestGate.snapshot();
      return !stopping && capacity.active < capacity.limit;
    }
  };
}
