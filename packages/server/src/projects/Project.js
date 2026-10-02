import { FrameAggregator } from '../aggregation/FrameAggregator.js';
import { RecentClients } from '../clients/RecentClients.js';
import { ConfigRepository } from '../config/ConfigRepository.js';
import { normalizeCatalog } from '../control/catalog.js';
import { RecentLogs } from '../logs/RecentLogs.js';
import { HistoryAccumulator } from '../aggregation/history/index.js';
import { RecentEvents } from '../events/RecentEvents.js';

// One isolated project: its served config and catalog plus the in-memory
// telemetry views fed by sync. Config and catalog only change through publish,
// and accepted envelopes only land through commitIngest, so the invariants that
// tie those pieces together live here rather than in every caller.
export class Project {
  constructor(name, snapshot, config) {
    this.name = name;
    this.configRepo = new ConfigRepository(snapshot);
    this.aggregator = new FrameAggregator(config);
    this.clients = new RecentClients(config.recentClientsMax);
    this.events = new RecentEvents(config.recentEventsMax);
    this.logs = new RecentLogs(config.recentLogsMax);
    this.history = new HistoryAccumulator({
      project: name,
      clockSkewAllowanceMs: config.history.clockSkewAllowanceMs,
      maxAppVersionsPerProjectRoleTier: config.history.maxAppVersionsPerProjectRoleTier
    });
    this.catalog = normalizeCatalog(snapshot.catalog);
  }

  // Serve a newly committed config and catalog together. Events dropped from
  // the inspect allowlist are forgotten so they stop being served.
  publish(version, snapshot, catalog) {
    const configRepo = new ConfigRepository({ version, ...snapshot });
    for (const name of this.catalog.inspectEvents) {
      if (!catalog.inspectEvents.includes(name)) this.events.forget(name);
    }
    this.configRepo = configRepo;
    this.catalog = catalog;
  }

  prepareHistory(envelope) {
    return this.history.prepare(envelope, this.catalog.persistLogs);
  }

  // Apply an envelope that already passed validation, capacity and evidence checks.
  commitIngest(envelope, preparedHistory, source) {
    this.history.commit(preparedHistory);
    this.aggregator.ingest(envelope, this.catalog.persistLogs, source);
    this.clients.touch(envelope.client);
    this.events.ingest(envelope, this.catalog.inspectEvents);
    this.logs.ingest(envelope);
  }

  syncResponse(envelope) {
    return this.configRepo.buildResponse(envelope.configVersion, envelope.client, envelope.configContext);
  }
}
