import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConcurrencyGate } from '../capacity/ConcurrencyGate.js';
import { PayloadTooLargeError, readBody } from '../ingest/readBody.js';
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

function requestHostname(host) {
  if (typeof host !== 'string' || host.length === 0) return null;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
}

function validateBoundary(req, config) {
  const host = requestHostname(req.headers.host);
  if (!host || !config.allowedHosts.includes(host)) return 'host not allowed';
  const origin = req.headers.origin;
  if (origin !== undefined && (typeof origin !== 'string' || !config.allowedOrigins.includes(origin))) {
    return 'origin not allowed';
  }
  return null;
}

function bearerToken(config, environment) {
  const name = config.bearerTokenEnvironmentVariable;
  const token = environment[name];
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error(`MCP bearer token environment variable ${name} must contain at least 32 bytes`);
  }
  return token;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export function createMcpHttpServer(control, config, token) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) {
    throw new Error('MCP bearer token must contain at least 32 bytes');
  }
  const requestGate = new ConcurrencyGate(config.maxConcurrentRequests);
  const activeConnections = new Set();
  let stopping = false;
  let stopPromise = null;

  const server = http.createServer((req, res) => {
    const work = (async () => {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path !== config.path) {
        jsonRpcError(res, 404, 'Not found');
        return;
      }
      const boundaryError = validateBoundary(req, config);
      if (boundaryError) {
        jsonRpcError(res, 403, 'Forbidden');
        return;
      }
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
          try {
            raw = await readBody(req, config.maxRequestBytes);
          } catch (error) {
            if (error instanceof PayloadTooLargeError) {
              jsonRpcError(res, 413, 'Payload too large');
              return;
            }
            throw error;
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
    })();
    work.catch((error) => {
      control.diagnostics.report('mcp.http_unexpected', error, { method: req.method });
      jsonRpcError(res, 500, 'Internal server error');
    });
  });

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      await closeServer(server);
      await Promise.all([...activeConnections].map((connection) => connection.close()));
    })();
    return stopPromise;
  }

  server.wardxMcp = { config, requestGate, stop };
  return server;
}

export function createConfiguredMcpHttpServer(control, config, environment = process.env) {
  return createMcpHttpServer(control, config, bearerToken(config, environment));
}
