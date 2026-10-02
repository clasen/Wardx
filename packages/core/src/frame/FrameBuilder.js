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

  static rowCount(frame) {
    return rowCount(frame);
  }

  static splitToMaxBytes(frame, maxFrameBytes, maxFrameRows) {
    const steps = FrameBuilder._splitToMaxBytesSteps(frame, maxFrameBytes, maxFrameRows);
    let result = steps.next();
    while (!result.done) result = steps.next();
    return result.value;
  }

  static *_splitToMaxBytesSteps(frame, maxFrameBytes, maxFrameRows) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new Error('maxFrameBytes must be an integer at least 1024');
    }
    if (!Number.isInteger(maxFrameRows) || maxFrameRows < 1) {
      throw new Error('maxFrameRows must be an integer at least 1');
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
    let currentBytes = measure(current).bytes;
    let workBytes = 0;

    const finishCurrent = () => {
      const measured = measure(current);
      if (measured.bytes > maxFrameBytes) {
        throw new Error('frame splitter produced an oversized frame');
      }
      frames.push(current);
      jsons.push(measured.json);
      workBytes += measured.bytes;
      current = emptyFrame(frame.seq + frames.length, frame.from, frame.to);
      currentBytes = measure(current).bytes;
    };

    const tryAddRow = (kind, row, rowBytes) => {
      const parent = kind === 'events' || kind === 'logs' ? current : current.metrics;
      const rows = parent[kind];
      // The first distinct row also introduces the optional JSON property.
      const addedBytes = rowBytes + (rows?.length ? 1 : 0) +
        (kind === 'distincts' && !rows ? ',"distincts":[]'.length : 0);
      if (currentBytes + addedBytes > maxFrameBytes || rowCount(current) >= maxFrameRows) return false;
      if (rows) rows.push(row);
      else parent[kind] = [row];
      currentBytes += addedBytes;
      return true;
    };

    const addRow = (kind, row, countDrop = true) => {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      workBytes += rowBytes;
      if (tryAddRow(kind, row, rowBytes)) return true;
      if (rowCount(current) > 0) {
        finishCurrent();
        if (tryAddRow(kind, row, rowBytes)) return true;
      }
      if (countDrop) dropped[kind] += 1;
      return false;
    };

    for (const kind of Object.keys(dropped)) {
      let rows = kind === 'events' || kind === 'logs' ? frame[kind] : frame.metrics[kind];
      if (kind === 'distincts' && !rows) rows = [];
      for (const row of rows) {
        addRow(kind, row);
        // Use the physical frame limit as the cooperative serialization budget.
        if (workBytes >= maxFrameBytes) {
          workBytes = 0;
          yield;
        }
      }
    }

    const droppedRows = Object.values(dropped).reduce((sum, value) => sum + value, 0);
    if (
      droppedRows > 0 &&
      !addRow('counters', [INTERNAL.frameRowsDropped, null, droppedRows], false)
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
