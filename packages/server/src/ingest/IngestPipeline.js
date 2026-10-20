import { validateExperimentEvents } from './validate.js';
import { RetentionInputError } from '../storage/RetentionLedger.js';

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

function retentionEvents(envelope) {
  return envelope.frames.flatMap((frame) => frame.events
    .filter((row) => row[1] === 'retention.activity' || row[1] === 'retention.conversion')
    .map(([timestamp, , { subject, salt, channel, goal }]) => ({ timestamp, subject, salt, channel, goal })));
}

function rejected(status, error) {
  return { status, body: { ok: false, error } };
}

// Accepts an authenticated, schema-valid envelope into a project. Experiment
// events, history, persistence capacity and ledger evidence are all checked
// before the sink or any in-memory view sees the envelope. Retention activity
// and conversions from new subjects are dropped, not rejected, once the
// project's user capacity is reached; so are conversions naming a goal and
// first touches naming a channel beyond the project's label caps. Returns the
// status and body of the sync response.
export function createIngestPipeline({
  sink, persistence, experimentLedger, retentionLedger, stateStore, diagnostics, ingestMetrics
}) {
  return function ingest(project, envelope, source) {
    const name = project.name;
    const invalidExperiments = validateExperimentEvents(envelope, project.configRepo.experiments);
    if (invalidExperiments) {
      diagnostics.report('ingest.validation_rejected', new Error(invalidExperiments), { project: name });
      return rejected(400, invalidExperiments);
    }
    let preparedHistory;
    try {
      preparedHistory = project.prepareHistory(envelope);
    } catch (error) {
      diagnostics.report('ingest.history_rejected', error, { project: name, credentialLabel: source.label });
      return rejected(400, error.message);
    }
    const historyCapacity = persistence.canAcceptHistory(project.history, preparedHistory);
    if (!historyCapacity.accepted) {
      diagnostics.report('ingest.persistence_overloaded', new Error('SQLite pending history limit reached'), {
        project: name,
        pendingBatches: historyCapacity.batches,
        pendingBytes: historyCapacity.bytes
      });
      return rejected(503, 'overloaded');
    }
    const retention = retentionEvents(envelope);
    let rejectedEvidence;
    let dropped;
    try {
      const ingestEvidence = () => {
        const evidence = experimentLedger.ingestBatch(name, experimentEvents(envelope), source);
        rejectedEvidence = evidence.find(
          (result) => result.status === 'variant_conflict' || result.status === 'missing_exposure'
        );
        if (rejectedEvidence) return;
        dropped = retentionLedger.ingestBatch(name, retention);
      };
      if (retention.length > 0) stateStore.transaction(ingestEvidence);
      else ingestEvidence();
    } catch (error) {
      if (!(error instanceof RetentionInputError)) throw error;
      diagnostics.report('ingest.retention_rejected', error, { project: name });
      return rejected(400, error.message);
    }
    if (dropped?.activity > 0 || dropped?.conversions > 0) {
      ingestMetrics.retentionActivityDropped += dropped.activity;
      ingestMetrics.retentionConversionsDropped += dropped.conversions;
      diagnostics.report('ingest.retention_capacity', new Error('retention user or goal capacity reached'), {
        project: name,
        droppedActivity: dropped.activity,
        droppedConversions: dropped.conversions
      });
    }
    if (dropped?.channels > 0) {
      ingestMetrics.retentionChannelsDropped += dropped.channels;
      diagnostics.report('ingest.retention_channel_capacity', new Error('retention channel capacity reached'), {
        project: name,
        droppedChannels: dropped.channels
      });
    }
    if (rejectedEvidence) {
      diagnostics.report('ingest.experiment_rejected', new Error(rejectedEvidence.status), {
        project: name,
        credentialLabel: source.label,
        experiment: rejectedEvidence.experiment
      });
      return rejected(400, rejectedEvidence.status.replaceAll('_', ' '));
    }
    sink.ingest(envelope);
    project.commitIngest(envelope, preparedHistory, source);
    if (preparedHistory.updates.length > 0) persistence.mark('history');
    return { status: 200, body: project.syncResponse(envelope) };
  };
}
