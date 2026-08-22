import http from 'node:http';
import { ControlService } from './control/ControlService.js';
import { hydrateExperimentStats, persistExperimentStats } from './control/persist.js';
import { createSyncHandler, json } from './ingest/syncHandler.js';
import { loadServerConfig, validateServerConfig } from './loadConfig.js';
import { ProjectRegistry } from './projects/ProjectRegistry.js';
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
  const registry = new ProjectRegistry(config);
  hydrateExperimentStats(config, registry);
  const sink = createSink(config);
  const control = new ControlService({ config, registry });
  const handleSync = createSyncHandler({ config, registry, sink });

  const server = http.createServer((req, res) => {
    const host = req.headers.host || `${config.host}:${config.port}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const work = (async () => {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/v1/sync' && req.method === 'POST') {
        await handleSync(req, res);
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    })();
    work.catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' });
    });
  });

  server.wardx = { config, registry, control, sink };
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
  const stop = (code) => {
    persistExperimentStats(server.wardx.config, server.wardx.registry);
    process.exit(code);
  };
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  return { server, address, config };
}

export { loadServerConfig, validateServerConfig, ControlService };
