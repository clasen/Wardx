import { gunzipSync } from 'node:zlib';
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

export function createSyncHandler({ config, configRepo, aggregator, sink }) {
  return async function handleSync(req, res) {
    const key = req.headers['x-wardx-key'];
    const project = typeof key === 'string' ? projectForKey(config, key) : undefined;
    if (!project) {
      json(res, 401, { ok: false, error: 'unauthorized' });
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
    aggregator.ingest(body);
    const includeConfig = body.configVersion !== configRepo.version;
    json(res, 200, configRepo.buildResponse(includeConfig));
  };
}

export function createAdminHandler({ config, configRepo }) {
  return async function handleAdmin(req, res, url) {
    const adminKey = req.headers['x-wardx-admin-key'];
    if (adminKey !== config.adminKey) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/admin/config') {
      json(res, 200, {
        ok: true,
        version: configRepo.version,
        values: configRepo.values,
        experiments: configRepo.experiments
      });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/v1/admin/config') {
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
      let snapshot;
      try {
        snapshot = JSON.parse(raw.toString('utf8'));
      } catch {
        json(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      try {
        configRepo.replace(snapshot);
      } catch (err) {
        json(res, 400, { ok: false, error: err.message });
        return;
      }
      json(res, 200, { ok: true, version: configRepo.version });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  };
}

export { json };
