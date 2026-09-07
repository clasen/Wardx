import http from 'node:http';
import { ControlService } from './control/ControlService.js';
import { PersistenceCoordinator } from './control/PersistenceCoordinator.js';
import { createDiagnostics } from './diagnostics.js';
import { createSyncHandler, json } from './ingest/syncHandler.js';
import { loadServerConfig, validateServerConfig } from './loadConfig.js';
import { ProjectRegistry } from './projects/ProjectRegistry.js';
import { MemorySink } from './sinks/MemorySink.js';
import { NdjsonSink } from './sinks/NdjsonSink.js';
import { NullSink } from './sinks/NullSink.js';
import { CredentialRegistry } from './auth/CredentialRegistry.js';
import { ConcurrencyGate } from './capacity/ConcurrencyGate.js';
import { dirname, isAbsolute, resolve } from 'node:path';
import { SqliteStateStore } from './storage/SqliteStateStore.js';
import { RetentionLedger } from './storage/RetentionLedger.js';
import { ExperimentLedger } from './storage/ExperimentLedger.js';
import { normalizeCatalog } from './control/catalog.js';
import { createConfiguredMcpHttpServer } from './mcp/http.js';
import { OperationalHealth } from './OperationalHealth.js';

function createSink(config) {
  if (config.sink === 'null') return new NullSink();
  if (config.sink === 'memory') return new MemorySink(config);
  if (config.sink === 'ndjson') return new NdjsonSink(config);
  throw new Error(`unknown sink: ${config.sink}`);
}

function resolveNodeServer(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('server options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'server') throw new Error(`server options unknown key: ${key}`);
  }
  if (options.server === undefined) return http.createServer();
  const server = options.server;
  for (const method of ['on', 'once', 'off', 'listen', 'close', 'address', 'listenerCount']) {
    if (typeof server?.[method] !== 'function') {
      throw new Error('server options.server must be a Node HTTP-compatible server');
    }
  }
  if (server.listenerCount('request') > 0) {
    throw new Error('server options.server must not have a request listener');
  }
  return server;
}

function sqlitePath(config) {
  if (isAbsolute(config.sqlite.path) || !config.configPath) return config.sqlite.path;
  return resolve(dirname(config.configPath), config.sqlite.path);
}

function createStateStore(config) {
  return new SqliteStateStore({
    path: sqlitePath(config),
    settings: {
      synchronous: config.sqlite.synchronous,
      busyTimeoutMs: config.sqlite.busyTimeoutMs,
      walAutoCheckpointPages: config.sqlite.walAutoCheckpointPages,
      checkpointMode: config.sqlite.checkpointMode,
      maxWriteBatch: config.sqlite.maxWriteBatchRows,
      transactionTimeoutMs: config.sqlite.transactionTimeoutMs,
      maxHistoryBuckets: config.history.maxQueryBuckets,
      maxHistoryRows: Math.max(config.history.maxQueryRows, config.control.journalCapacity)
    }
  });
}

function hydrateAuthoritativeState(config, stateStore) {
  for (const [project, bootstrap] of Object.entries(config.projects)) {
    const stored = stateStore.readProjectState(project);
    if (!stored) {
      stateStore.saveProjectState({
        project,
        version: bootstrap.version,
        state: {
          values: bootstrap.values,
          keyRoles: bootstrap.keyRoles,
          experiments: bootstrap.experiments
        },
        catalog: normalizeCatalog(bootstrap.catalog)
      });
      continue;
    }
    config.projects[project] = {
      version: stored.version,
      values: stored.state.values,
      keyRoles: stored.state.keyRoles,
      experiments: stored.state.experiments,
      catalog: stored.catalog
    };
  }
}

function hydrateHistoricalState(config, stateStore, registry) {
  for (const project of registry.names()) {
    const buckets = [];
    for (const tier of ['minute', 'hour', 'day']) {
      let afterFrom = -1;
      while (true) {
        const starts = stateStore.listBucketStarts({
          project,
          tier,
          afterFrom,
          limit: config.sqlite.maxWriteBatchRows
        });
        for (const from of starts) buckets.push(stateStore.readBucket(project, tier, from));
        if (starts.length < config.sqlite.maxWriteBatchRows) break;
        afterFrom = starts.at(-1);
      }
    }
    registry.get(project).history.seed(buckets);
  }
}

export function createIngestServer(configInput, options = {}) {
  const server = resolveNodeServer(options);
  const config = validateServerConfig(configInput);
  const stateStore = createStateStore(config);
  let registry;
  try {
    hydrateAuthoritativeState(config, stateStore);
    registry = new ProjectRegistry(config);
    hydrateHistoricalState(config, stateStore, registry);
  } catch (error) {
    stateStore.close({ checkpoint: false });
    throw error;
  }
  const credentials = new CredentialRegistry(config.credentials);
  const syncGate = new ConcurrencyGate(config.capacity.maxConcurrentSyncHandlers);
  const diagnostics = createDiagnostics(config);
  const persistence = new PersistenceCoordinator({ config, registry, diagnostics, stateStore });
  const experimentLedger = new ExperimentLedger({ store: stateStore, maxRows: config.experiments.ledgerMaxRows });
  const retentionLedger = new RetentionLedger({ store: stateStore, settings: config.retention });
  const sink = createSink(config);
  const control = new ControlService({ config, registry, persistence, diagnostics, stateStore, experimentLedger, retentionLedger });
  const handleSync = createSyncHandler({
    config,
    registry,
    credentials,
    sink,
    persistence,
    experimentLedger,
    retentionLedger,
    stateStore,
    diagnostics
  });
  const health = new OperationalHealth({
    config: config.readiness,
    stateStore,
    persistence,
    syncGate,
    mcpReady: () => !config.mcpHttp.enabled || Boolean(server.wardx?.mcpHttp?.isReady())
  });

  server.on('request', (req, res) => {
    const host = req.headers.host || `${config.host}:${config.port}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const work = (async () => {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ready') {
        const readiness = health.snapshot();
        res.setHeader('cache-control', 'no-store');
        json(res, readiness.ok ? 200 : 503, readiness);
        return;
      }
      if (url.pathname === '/v1/sync' && req.method === 'POST') {
        const leave = syncGate.enter();
        if (!leave) {
          diagnostics.report('ingest.overloaded', new Error('concurrent sync limit reached'));
          json(res, 503, { ok: false, error: 'overloaded' });
          return;
        }
        try {
          await handleSync(req, res);
        } finally {
          leave();
        }
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    })();
    work.catch((error) => {
      diagnostics.report('http.unexpected', error, { method: req.method, path: url.pathname });
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' });
    });
  });

  let stopPromise = null;
  async function stop() {
    if (stopPromise) return stopPromise;
    health.stop();
    stopPromise = (async () => {
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
      await persistence.close();
      if (typeof sink.close === 'function') await sink.close();
      stateStore.close();
    })();
    return stopPromise;
  }
  server.wardx = {
    config,
    registry,
    credentials,
    control,
    sink,
    persistence,
    stateStore,
    experimentLedger,
    retentionLedger,
    diagnostics,
    syncGate,
    health,
    stop
  };
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

export async function startServer(config, options = {}) {
  const server = createIngestServer(config, options);
  const address = await listen(server, config.port, config.host);
  let mcpAddress = null;
  if (server.wardx.config.mcpHttp.enabled) {
    let mcpServer;
    try {
      mcpServer = createConfiguredMcpHttpServer(server.wardx.control, server.wardx.config.mcpHttp);
      mcpAddress = await listen(
        mcpServer,
        server.wardx.config.mcpHttp.port,
        server.wardx.config.mcpHttp.host
      );
    } catch (error) {
      await server.wardx.stop();
      throw error;
    }
    const stopIngest = server.wardx.stop;
    let stopPromise = null;
    server.wardx.mcpHttp = mcpServer.wardxMcp;
    server.wardx.stop = () => {
      if (!stopPromise) {
        server.wardx.health.stop();
        stopPromise = mcpServer.wardxMcp.stop().then(stopIngest);
      }
      return stopPromise;
    };
  }
  const stop = async (code) => {
    try {
      await server.wardx.stop();
      process.exit(code);
    } catch (error) {
      server.wardx.diagnostics.report('shutdown.failed', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  return { server, address, mcpAddress, config };
}

export { loadServerConfig, validateServerConfig, ControlService };
