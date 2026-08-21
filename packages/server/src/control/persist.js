import { renameSync, writeFileSync } from 'node:fs';

function fileShape(config, registry) {
  const projects = {};
  for (const name of registry.names()) {
    const store = registry.get(name);
    projects[name] = {
      ...store.configRepo.snapshot(),
      catalog: store.catalog
    };
  }
  const out = {
    host: config.host,
    port: config.port,
    projectKeys: config.projectKeys,
    sink: config.sink,
    maxRequestBytes: config.maxRequestBytes,
    aggregateRetentionMinutes: config.aggregateRetentionMinutes,
    aggregateMaxSeriesPerMetric: config.aggregateMaxSeriesPerMetric,
    memorySinkMaxEnvelopes: config.memorySinkMaxEnvelopes,
    recentClientsMax: config.recentClientsMax,
    recentLogsMax: config.recentLogsMax,
    projects
  };
  if (typeof config.ndjsonPath === 'string' && config.ndjsonPath.length > 0) {
    out.ndjsonPath = config.ndjsonPath;
  }
  return out;
}

export function persistServerConfig(config, registry) {
  const path = config.configPath;
  if (!path) return;
  const body = JSON.stringify(fileShape(config, registry), null, 2) + '\n';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}
