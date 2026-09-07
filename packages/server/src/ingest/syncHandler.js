import { gunzipSync } from 'node:zlib';
import { PayloadTooLargeError, readBody } from './readBody.js';
import { validateEnvelope, validateExperimentEvents } from './validate.js';
import { CredentialAuthorizationError } from '../auth/CredentialRegistry.js';
import { RetentionInputError, RetentionCapacityError } from '../storage/RetentionLedger.js';

function json(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function experimentEvents(envelope) {
  const events = [];
  for (const frame of envelope.frames) {
    for (const row of frame.events) {
      const name = row[1];
      const attrs = row[2];
      if (name === 'experiment.exposure') {
        events.push({
          kind: 'exposure',
          experiment: attrs.experiment,
          variant: attrs.variant,
          assignmentHash: attrs.subject,
          timestamp: row[0]
        });
      } else if (name === 'experiment.goal') {
        const assignment = attrs.experiments[0];
        events.push({
          kind: 'goal',
          experiment: assignment.experiment,
          variant: assignment.variant,
          assignmentHash: attrs.subject,
          timestamp: row[0],
          value: attrs.value === undefined ? 1 : attrs.value
        });
      }
    }
  }
  return events;
}

export function createSyncHandler({
  config,
  registry,
  credentials,
  sink,
  persistence,
  experimentLedger,
  retentionLedger,
  stateStore,
  diagnostics
}) {
  return async function handleSync(req, res) {
    const key = req.headers['x-wardx-key'];
    let credential;
    try {
      credential = credentials.authenticate(key);
    } catch (error) {
      if (!(error instanceof CredentialAuthorizationError)) throw error;
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const project = credential.project;
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
    let source;
    try {
      source = credentials.authorize(credential, body.client.role);
    } catch (error) {
      if (!(error instanceof CredentialAuthorizationError)) throw error;
      diagnostics.report('ingest.role_rejected', error, { project, credentialLabel: credential.label });
      json(res, 403, { ok: false, error: 'role not allowed' });
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
    let preparedHistory;
    try {
      preparedHistory = store.history.prepare(body, store.catalog.persistLogs);
    } catch (error) {
      diagnostics.report('ingest.history_rejected', error, { project, credentialLabel: source.label });
      json(res, 400, { ok: false, error: error.message });
      return;
    }
    const historyCapacity = persistence.canAcceptHistory(store.history, preparedHistory);
    if (!historyCapacity.accepted) {
      diagnostics.report('ingest.persistence_overloaded', new Error('SQLite pending history limit reached'), {
        project,
        pendingBatches: historyCapacity.batches,
        pendingBytes: historyCapacity.bytes
      });
      json(res, 503, { ok: false, error: 'overloaded' });
      return;
    }
    const activity = body.frames.flatMap((frame) => frame.events
      .filter((row) => row[1] === 'retention.activity')
      .map(([timestamp, , attrs]) => ({ timestamp, subject: attrs.subject, salt: attrs.salt })));
    let rejectedEvidence;
    try {
      const ingestEvidence = () => {
        const evidence = experimentLedger.ingestBatch(project, experimentEvents(body), source);
        rejectedEvidence = evidence.find(
          (result) => result.status === 'variant_conflict' || result.status === 'missing_exposure'
        );
        if (rejectedEvidence) return;
        retentionLedger.ingestBatch(project, activity);
      };
      if (activity.length > 0) stateStore.transaction(ingestEvidence);
      else ingestEvidence();
    } catch (error) {
      if (!(error instanceof RetentionInputError) && !(error instanceof RetentionCapacityError)) throw error;
      diagnostics.report('ingest.retention_rejected', error, { project });
      json(res, error instanceof RetentionCapacityError ? 503 : 400, { ok: false, error: error.message });
      return;
    }
    if (rejectedEvidence) {
      diagnostics.report('ingest.experiment_rejected', new Error(rejectedEvidence.status), {
        project,
        credentialLabel: source.label,
        experiment: rejectedEvidence.experiment
      });
      json(res, 400, { ok: false, error: rejectedEvidence.status.replaceAll('_', ' ') });
      return;
    }
    sink.ingest(body);
    store.history.commit(preparedHistory);
    store.aggregator.ingest(body, store.catalog.persistLogs, source);
    if (preparedHistory.updates.length > 0) persistence.mark('history');
    store.clients.touch(body.client);
    store.events.ingest(body, store.catalog.inspectEvents);
    store.logs.ingest(body);
    const includeConfig = body.configVersion !== store.configRepo.version;
    json(res, 200, store.configRepo.buildResponse(includeConfig, body.client.role));
  };
}

export { json };
