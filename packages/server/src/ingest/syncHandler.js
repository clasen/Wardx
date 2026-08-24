import { gunzipSync } from 'node:zlib';
import { PayloadTooLargeError, readBody } from './readBody.js';
import { validateEnvelope, validateExperimentEvents } from './validate.js';

function json(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function projectForKey(config, key) {
  return config.projectKeys[key];
}

export function createSyncHandler({ config, registry, sink, persistence, diagnostics }) {
  return async function handleSync(req, res) {
    const key = req.headers['x-wardx-key'];
    const project = typeof key === 'string' ? projectForKey(config, key) : undefined;
    if (!project) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const store = registry.get(project);
    if (!store) {
      json(res, 400, { ok: false, error: 'unknown project' });
      return;
    }
    const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
    if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip') {
      json(res, 415, { ok: false, error: 'unsupported content encoding' });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, config.maxRequestBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        json(res, 413, { ok: false, error: 'payload too large' });
        return;
      }
      throw err;
    }
    let decoded = raw;
    if (encoding === 'gzip') {
      try {
        decoded = gunzipSync(raw, { maxOutputLength: config.maxRequestBytes });
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
          json(res, 413, { ok: false, error: 'payload too large' });
          return;
        }
        json(res, 400, { ok: false, error: 'invalid gzip' });
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(decoded.toString('utf8'));
    } catch {
      json(res, 400, { ok: false, error: 'invalid json' });
      return;
    }
    const invalid = validateEnvelope(body, config);
    if (invalid) {
      diagnostics.report('ingest.validation_rejected', new Error(invalid), { project });
      json(res, 400, { ok: false, error: invalid });
      return;
    }
    if (body.project !== project) {
      json(res, 400, { ok: false, error: 'project does not match key' });
      return;
    }
    const invalidExperiments = validateExperimentEvents(body, store.configRepo.experiments);
    if (invalidExperiments) {
      diagnostics.report('ingest.validation_rejected', new Error(invalidExperiments), { project });
      json(res, 400, { ok: false, error: invalidExperiments });
      return;
    }
    sink.ingest(body);
    const changed = store.aggregator.ingest(body, store.catalog.persistLogs);
    if (changed.experiments) persistence.mark('experimentStats');
    if (changed.persistLogs) persistence.mark('logStats');
    if (changed.windows) persistence.mark('aggregateWindows');
    store.clients.touch(body.client);
    store.logs.ingest(body);
    const includeConfig = body.configVersion !== store.configRepo.version;
    json(res, 200, store.configRepo.buildResponse(includeConfig, body.client.role));
  };
}

export { json };
