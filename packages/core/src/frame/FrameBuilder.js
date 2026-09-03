import { INTERNAL } from '../protocol.js';

function measure(frame) {
  const json = JSON.stringify(frame);
  return { json, bytes: Buffer.byteLength(json, 'utf8') };
}

function emptyFrame(seq, from, to) {
  return {
    seq,
    from,
    to,
    metrics: { counters: [], gauges: [], histograms: [] },
    events: [],
    logs: []
  };
}

function rowCount(frame) {
  return (
    frame.metrics.counters.length +
    frame.metrics.gauges.length +
    frame.metrics.histograms.length +
    (frame.metrics.distincts?.length || 0) +
    frame.events.length +
    frame.logs.length
  );
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
        histograms,
        ...(metrics.distincts?.length > 0 ? { distincts: metrics.distincts.slice() } : {})
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

  static splitToMaxBytes(frame, maxFrameBytes) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new Error('maxFrameBytes must be an integer at least 1024');
    }
    const frames = [];
    const jsons = [];
    const dropped = {
      counters: 0,
      gauges: 0,
      histograms: 0,
      distincts: 0,
      events: 0,
      logs: 0
    };
    let current = emptyFrame(frame.seq, frame.from, frame.to);

    const finishCurrent = () => {
      const measured = measure(current);
      if (measured.bytes > maxFrameBytes) {
        throw new Error('frame splitter produced an oversized frame');
      }
      frames.push(current);
      jsons.push(measured.json);
      current = emptyFrame(frame.seq + frames.length, frame.from, frame.to);
    };

    const addRow = (collection, row, countDrop = true) => {
      collection(current).push(row);
      if (measure(current).bytes <= maxFrameBytes) return true;
      collection(current).pop();
      if (collection.kind === 'distincts' && current.metrics.distincts.length === 0) {
        delete current.metrics.distincts;
      }
      if (rowCount(current) > 0) {
        finishCurrent();
        collection(current).push(row);
        if (measure(current).bytes <= maxFrameBytes) return true;
        collection(current).pop();
        if (collection.kind === 'distincts' && current.metrics.distincts.length === 0) {
          delete current.metrics.distincts;
        }
      }
      if (countDrop) dropped[collection.kind] += 1;
      return false;
    };

    const counters = (candidate) => candidate.metrics.counters;
    counters.kind = 'counters';
    const gauges = (candidate) => candidate.metrics.gauges;
    gauges.kind = 'gauges';
    const histograms = (candidate) => candidate.metrics.histograms;
    histograms.kind = 'histograms';
    const distincts = (candidate) => {
      if (!candidate.metrics.distincts) candidate.metrics.distincts = [];
      return candidate.metrics.distincts;
    };
    distincts.kind = 'distincts';
    const events = (candidate) => candidate.events;
    events.kind = 'events';
    const logs = (candidate) => candidate.logs;
    logs.kind = 'logs';

    for (const row of frame.metrics.counters) addRow(counters, row);
    for (const row of frame.metrics.gauges) addRow(gauges, row);
    for (const row of frame.metrics.histograms) addRow(histograms, row);
    for (const row of frame.metrics.distincts || []) addRow(distincts, row);
    for (const row of frame.events) addRow(events, row);
    for (const row of frame.logs) addRow(logs, row);

    const droppedRows = Object.values(dropped).reduce((sum, value) => sum + value, 0);
    if (
      droppedRows > 0 &&
      !addRow(counters, [INTERNAL.frameRowsDropped, null, droppedRows], false)
    ) {
      throw new Error('maxFrameBytes cannot contain the frame drop metric');
    }
    if (frames.length === 0 || rowCount(current) > 0) finishCurrent();

    return {
      frames,
      jsons,
      droppedRows,
      droppedCounters: dropped.counters,
      droppedGauges: dropped.gauges,
      droppedHistograms: dropped.histograms,
      droppedDistincts: dropped.distincts,
      droppedEvents: dropped.events,
      droppedLogs: dropped.logs
    };
  }
}
