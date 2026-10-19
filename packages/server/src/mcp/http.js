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

function authorized(header, expectedToken) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function readMcpBearerToken(config, environment = process.env) {
  const name = config.bearerTokenEnvironmentVariable;
  const token = environment[name];
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error(`MCP bearer token environment variable ${name} must contain at least 32 bytes`);
  }
  return token;
}

export function createMcpHttpHandler(control, config, token) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error('MCP bearer token must contain at least 32 bytes');
  }
  const requestGate = new ConcurrencyGate(config.maxConcurrentRequests);
  const activeConnections = new Set();
  let stopping = false;
  let stopPromise = null;

  async function serve(req, res) {
    if (!authorized(req.headers.authorization, token)) {
      jsonRpcError(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
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

      const mcp = createMcpServer(control);
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
