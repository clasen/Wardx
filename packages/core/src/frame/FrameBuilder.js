import { INTERNAL } from '../protocol.js';
import { LOG_RANK } from '../protocol.js';

function measure(frame) {
  const json = JSON.stringify(frame);
  return { json, bytes: Buffer.byteLength(json, 'utf8') };
}

function logDropOrder(logs) {
  return logs
    .map((_, index) => index)
    .sort((a, b) => {
      const rankA = LOG_RANK[logs[a][1]];
      const rankB = LOG_RANK[logs[b][1]];
      const aKey = rankA === undefined ? Infinity : rankA;
      const bKey = rankB === undefined ? Infinity : rankB;
      if (aKey !== bKey) return aKey - bKey;
      return a - b;
    });
}

function logsWithoutFirstK(logs, dropOrder, k) {
  if (k <= 0) return logs;
  if (k >= logs.length) return [];
  const drop = new Set(dropOrder.slice(0, k));
  return logs.filter((_, index) => !drop.has(index));
}

function leastDrops(maxDrop, fits) {
  if (maxDrop === 0) return 0;
  if (!fits(maxDrop)) return maxDrop;
  let lo = 0;
  let hi = maxDrop;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function isInternalGauge(row) {
  return typeof row[0] === 'string' && row[0].startsWith('wardx.internal.');
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
    let { json, bytes } = measure(frame);
    if (bytes <= maxFrameBytes) return { frame, json, droppedLogs: 0, droppedEvents: 0 };

    let droppedLogs = 0;
    let droppedEvents = 0;

    if (frame.logs.length > 0) {
      const dropOrder = logDropOrder(frame.logs);
      const k = leastDrops(dropOrder.length, (mid) => {
        const probe = { ...frame, logs: logsWithoutFirstK(frame.logs, dropOrder, mid) };
        return measure(probe).bytes <= maxFrameBytes;
      });
      frame.logs = logsWithoutFirstK(frame.logs, dropOrder, k);
      droppedLogs = k;
      ({ json, bytes } = measure(frame));
      if (bytes <= maxFrameBytes) return { frame, json, droppedLogs, droppedEvents };
    }

    if (frame.events.length > 0) {
      const original = frame.events;
      const k = leastDrops(original.length, (mid) => {
        const probe = { ...frame, events: original.slice(0, original.length - mid) };
        return measure(probe).bytes <= maxFrameBytes;
      });
      frame.events = original.slice(0, original.length - k);
      droppedEvents = k;
      ({ json, bytes } = measure(frame));
      if (bytes <= maxFrameBytes) return { frame, json, droppedLogs, droppedEvents };
    }

    if (bytes > maxFrameBytes && frame.metrics.histograms.length > 0) {
      frame.metrics.histograms = [];
      ({ json, bytes } = measure(frame));
    }
    if (bytes > maxFrameBytes) {
      frame.metrics.gauges = frame.metrics.gauges.filter(isInternalGauge);
      ({ json } = measure(frame));
    }
    return { frame, json, droppedLogs, droppedEvents };
  }
}
