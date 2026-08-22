import { gunzipSync } from 'node:zlib';
import { persistExperimentStats } from '../control/persist.js';
import { PayloadTooLargeError, readBody } from './readBody.js';
import { validateEnvelope } from './validate.js';

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

export function createSyncHandler({ config, registry, sink }) {
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
    const encoding = String(req.headers['content-encoding'] || '').toLowerCase();
    let decoded = raw;
    if (encoding === 'gzip') {
      try {
        decoded = gunzipSync(raw);
      } catch {
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
    const invalid = validateEnvelope(body);
    if (invalid) {
      json(res, 400, { ok: false, error: invalid });
      return;
    }
    if (body.project !== project) {
      json(res, 400, { ok: false, error: 'project does not match key' });
      return;
    }
    sink.ingest(body);
    if (store.aggregator.ingest(body)) persistExperimentStats(config, registry);
    store.clients.touch(body.client);
    store.logs.ingest(body);
    const includeConfig = body.configVersion !== store.configRepo.version;
    json(res, 200, store.configRepo.buildResponse(includeConfig, body.client.role));
  };
}

export { json };
