function formatDims(dims) {
  if (!dims || typeof dims !== 'object') return '';
  const keys = Object.keys(dims);
  if (keys.length === 0) return '';
  return ' ' + keys.map((key) => `${key}=${dims[key]}`).join(',');
}

function write(stream, kind, rest) {
  stream.write(`wardx  ${kind.padEnd(10)} ${rest}\n`);
}

export function createConsoleTracer(options) {
  const stream = options && options.stream ? options.stream : process.stderr;
  return {
    measure(record) {
      const noop = record.noop ? ' noop' : '';
      const attrs = record.attrs ? formatDims(record.attrs) : '';
      write(
        stream,
        record.type,
        `${record.name}${formatDims(record.dims)}  ${record.op} ${record.value}${attrs}${noop}`
      );
    },
    event(record) {
      const dropped = record.dropped ? ' dropped' : '';
      write(stream, 'event', `${record.name}${formatDims(record.attrs)}${dropped}`);
    },
    log(record) {
      const dropped = record.dropped ? ' dropped' : '';
      write(stream, 'log', `${record.level} ${record.message}${formatDims(record.attrs)}${dropped}`);
    },
    frame(record) {
      const dropped = [];
      if (record.droppedLogs) dropped.push(`droppedLogs=${record.droppedLogs}`);
      if (record.droppedEvents) dropped.push(`droppedEvents=${record.droppedEvents}`);
      const extra = dropped.length > 0 ? `  ${dropped.join(' ')}` : '';
      write(
        stream,
        'frame',
        `seq=${record.seq}  counters=${record.counters} gauges=${record.gauges} histograms=${record.histograms} events=${record.events} logs=${record.logs}${extra}`
      );
    },
    sync(record) {
      const result = record.ok ? 'ok' : 'fail';
      const config =
        record.configVersion === undefined ? '' : ` config=${record.configVersion}`;
      const applied = record.appliedConfig ? ' +config' : '';
      const status = record.status === undefined ? '' : ` status=${record.status}`;
      write(
        stream,
        'sync',
        `${record.phase} frames=${record.frames} gzip=${record.bytesCompressed}B ${record.ms.toFixed(1)}ms ${result}${status}${config}${applied}`
      );
    }
  };
}
