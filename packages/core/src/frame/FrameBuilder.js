import { INTERNAL } from '../protocol.js';
import { LOG_RANK } from '../protocol.js';

function byteLength(json) {
  return Buffer.byteLength(json, 'utf8');
}

function dropLowestLogs(logs) {
  let victim = -1;
  let victimRank = Infinity;
  for (let i = 0; i < logs.length; i++) {
    const rank = LOG_RANK[logs[i][1]];
    if (rank < victimRank) {
      victimRank = rank;
      victim = i;
    }
  }
  if (victim === -1) return false;
  logs.splice(victim, 1);
  return true;
}

export class FrameBuilder {
  static build({ seq, from, to, metrics, events, logs, internal }) {
    const counters = metrics.counters.slice();
    const gauges = metrics.gauges.slice();
    const histograms = metrics.histograms.slice();
    FrameBuilder.mergeInternal(counters, gauges, internal);
    return {
      seq,
      from,
      to,
      metrics: {
        counters,
        gauges,
        histograms
      },
      events,
      logs
    };
  }

  static mergeInternal(counters, gauges, internal) {
    if (internal.eventsDropped) counters.push([INTERNAL.eventsDropped, null, internal.eventsDropped]);
    if (internal.logsDropped) counters.push([INTERNAL.logsDropped, null, internal.logsDropped]);
    if (internal.cardinalityDropped) {
      counters.push([INTERNAL.cardinalityDropped, null, internal.cardinalityDropped]);
    }
    if (internal.framesSent) counters.push([INTERNAL.framesSent, null, internal.framesSent]);
    if (internal.framesFailed) counters.push([INTERNAL.framesFailed, null, internal.framesFailed]);
    if (internal.bytesUncompressed) {
      counters.push([INTERNAL.bytesUncompressed, null, internal.bytesUncompressed]);
    }
    if (internal.bytesCompressed) {
      counters.push([INTERNAL.bytesCompressed, null, internal.bytesCompressed]);
    }
    gauges.push([INTERNAL.eventsBuffered, null, internal.eventsBuffered, Date.now()]);
    gauges.push([INTERNAL.logsBuffered, null, internal.logsBuffered, Date.now()]);
    if (internal.lastSyncMs) {
      gauges.push([INTERNAL.lastSyncMs, null, internal.lastSyncMs, Date.now()]);
    }
    gauges.push([INTERNAL.configVersion, null, internal.configVersion, Date.now()]);
    if (internal.processRssBytes) {
      gauges.push([INTERNAL.processRssBytes, null, internal.processRssBytes, Date.now()]);
    }
  }

  static fitToMaxBytes(frame, maxFrameBytes) {
    let json = JSON.stringify(frame);
    if (byteLength(json) <= maxFrameBytes) return { frame, json, droppedLogs: 0, droppedEvents: 0 };
    let droppedLogs = 0;
    let droppedEvents = 0;
    while (byteLength(json) > maxFrameBytes && frame.logs.length > 0) {
      if (!dropLowestLogs(frame.logs)) break;
      droppedLogs += 1;
      json = JSON.stringify(frame);
    }
    while (byteLength(json) > maxFrameBytes && frame.events.length > 0) {
      frame.events.pop();
      droppedEvents += 1;
      json = JSON.stringify(frame);
    }
    if (byteLength(json) > maxFrameBytes) {
      frame.metrics.histograms = [];
      json = JSON.stringify(frame);
    }
    if (byteLength(json) > maxFrameBytes) {
      frame.metrics.gauges = frame.metrics.gauges.filter((row) => {
        return typeof row[0] === 'string' && row[0].startsWith('wardx.internal.');
      });
      json = JSON.stringify(frame);
    }
    return { frame, json, droppedLogs, droppedEvents };
  }
}
