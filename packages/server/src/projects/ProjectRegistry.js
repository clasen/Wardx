import { FrameAggregator } from '../aggregation/FrameAggregator.js';
import { RecentClients } from '../clients/RecentClients.js';
import { ConfigRepository } from '../config/ConfigRepository.js';
import { normalizeCatalog } from '../control/catalog.js';
import { RecentLogs } from '../logs/RecentLogs.js';
import { HistoryAccumulator } from '../aggregation/history/index.js';
import { RecentEvents } from '../events/RecentEvents.js';

export class ProjectRegistry {
  constructor(config) {
    this.byName = new Map();
    for (const [name, snapshot] of Object.entries(config.projects)) {
      this.byName.set(name, {
        configRepo: new ConfigRepository(snapshot),
        aggregator: new FrameAggregator(config),
        clients: new RecentClients(config.recentClientsMax),
        events: new RecentEvents(config.recentEventsMax),
        logs: new RecentLogs(config.recentLogsMax),
        history: new HistoryAccumulator({
          project: name,
          clockSkewAllowanceMs: config.history.clockSkewAllowanceMs,
          maxAppVersionsPerProjectRoleTier: config.history.maxAppVersionsPerProjectRoleTier
        }),
        catalog: normalizeCatalog(snapshot.catalog)
      });
    }
  }

  get(name) {
    return this.byName.get(name);
  }

  names() {
    return [...this.byName.keys()].sort();
  }
}
