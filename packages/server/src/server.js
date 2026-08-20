import http from 'node:http';
import { FrameAggregator } from './aggregation/FrameAggregator.js';
import { ConfigRepository } from './config/ConfigRepository.js';
import { createAdminHandler, createSyncHandler, json } from './ingest/syncHandler.js';
import { loadServerConfig, validateServerConfig } from './loadConfig.js';
import { MemorySink } from './sinks/MemorySink.js';
import { NdjsonSink } from './sinks/NdjsonSink.js';
import { NullSink } from './sinks/NullSink.js';

function createSink(config) {
  if (config.sink === 'null') return new NullSink();
  if (config.sink === 'memory') return new MemorySink(config);
  if (config.sink === 'ndjson') return new NdjsonSink(config);
  throw new Error(`unknown sink: ${config.sink}`);
}

export function createIngestServer(configInput) {
  const config = validateServerConfig(configInput);
  const configRepo = new ConfigRepository(config.config);
  const aggregator = new FrameAggregator(config);
  const sink = createSink(config);
  const handleSync = createSyncHandler({ config, configRepo, aggregator, sink });
  const handleAdmin = createAdminHandler({ config, configRepo });

  const server = http.createServer((req, res) => {
    const host = req.headers.host || `${config.host}:${config.port}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const work = (async () => {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/admin/aggregates') {
        const adminKey = req.headers['x-wardx-admin-key'];
        if (adminKey !== config.adminKey) {
          json(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        json(res, 200, { ok: true, windows: aggregator.snapshot() });
        return;
      }
      if (url.pathname === '/v1/sync' && req.method === 'POST') {
        await handleSync(req, res);
        return;
      }
      if (url.pathname.startsWith('/v1/admin/')) {
        await handleAdmin(req, res, url);
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    })();
    work.catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' });
    });
  });

  server.wardx = { config, configRepo, aggregator, sink };
  return server;
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address());
    });
  });
}

export async function startServer(config) {
  const server = createIngestServer(config);
  const address = await listen(server, config.port, config.host);
  return { server, address, config };
}

export { loadServerConfig, validateServerConfig };
