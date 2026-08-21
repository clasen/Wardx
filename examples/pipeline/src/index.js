import { gzipSync } from 'node:zlib';
import { createIngestServer, executeTool, listen } from '@wardx/server';
import { createWardx } from 'wardx';

const PROJECT = 'demo';
const PROJECT_KEY = 'dev_project_key';

function banner(title) {
  process.stdout.write(`\n${'═'.repeat(72)}\n${title}\n${'═'.repeat(72)}\n`);
}

function line(text) {
  process.stdout.write(`${text}\n`);
}

function formatDims(dims) {
  if (!dims || typeof dims !== 'object') return '';
  const keys = Object.keys(dims);
  if (keys.length === 0) return '';
  return ' {' + keys.map((key) => `${key}=${dims[key]}`).join(', ') + '}';
}

function formatNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

function legend(row) {
  return row.description ? `  — ${row.description}` : '';
}

function isInternal(name) {
  return typeof name === 'string' && name.startsWith('wardx.internal.');
}

function productRows(rows, nameIndex = 0) {
  return rows.filter((row) => !isInternal(Array.isArray(row) ? row[nameIndex] : row.name));
}

function printFrame(frame, label) {
  line(`  ${label}  seq=${frame.seq}  window=${frame.to - frame.from}ms`);
  const counters = productRows(frame.metrics.counters);
  const gauges = productRows(frame.metrics.gauges);
  const histograms = productRows(frame.metrics.histograms);
  const internalCount =
    frame.metrics.counters.length -
    counters.length +
    (frame.metrics.gauges.length - gauges.length) +
    (frame.metrics.histograms.length - histograms.length);
  if (counters.length === 0 && gauges.length === 0 && histograms.length === 0) {
    line('    (no product metrics in this frame)');
  }
  for (const [name, dims, value] of counters) {
    line(`    counter    ${name}${formatDims(dims)}  delta=${value}`);
  }
  for (const [name, dims, value] of gauges) {
    line(`    gauge      ${name}${formatDims(dims)}  last=${value}`);
  }
  for (const [name, dims, body] of histograms) {
    const buckets = body.buckets
      .filter((pair) => pair[1] > 0)
      .map((pair) => `<=${pair[0]}:${pair[1]}`)
      .join('  ');
    line(
      `    histogram  ${name}${formatDims(dims)}  count=${body.count} sum=${formatNum(body.sum)} min=${formatNum(body.min)} max=${formatNum(body.max)}`
    );
    if (buckets) line(`               buckets  ${buckets}`);
    if (body.exemplar) {
      line(
        `               exemplar  value=${formatNum(body.exemplar.value)}${formatDims(body.exemplar.attrs)}`
      );
    }
  }
  for (const [, name, attrs] of frame.events) {
    line(`    event      ${name}${formatDims(attrs)}`);
  }
  for (const [, level, message] of frame.logs) {
    line(`    log        ${level} ${message}`);
  }
  line(`    + ${internalCount} wardx.internal.* series (SDK health, omitted)`);
}

function printEnvelope(envelope, index) {
  const json = JSON.stringify(envelope);
  const gzipBytes = gzipSync(Buffer.from(json)).length;
  line(
    `  envelope #${index}  POST /v1/sync  frames=${envelope.frames.length}  json=${Buffer.byteLength(json)}B  gzip=${gzipBytes}B  configVersion=${envelope.configVersion}`
  );
  if (envelope.frames.length === 0) {
    line('    bootstrap: empty frames, client is fetching Remote Config');
    return;
  }
  envelope.frames.forEach((frame, i) => printFrame(frame, `frame ${i + 1}`));
}

function printQueryWindow(window) {
  line(
    `  minute ${new Date(window.from).toISOString()}  frames=${window.frames} events=${window.events} logs=${window.logs}`
  );
  for (const row of productRows(window.counters)) {
    line(`    counter    ${row.name}${formatDims(row.dims)}  = ${row.value}${legend(row)}`);
  }
  for (const row of productRows(window.gauges)) {
    line(`    gauge      ${row.name}${formatDims(row.dims)}  = ${row.value}${legend(row)}`);
  }
  for (const row of productRows(window.histograms)) {
    const body = row.body;
    line(
      `    histogram  ${row.name}${formatDims(row.dims)}  count=${body.count} sum=${formatNum(body.sum)} min=${formatNum(body.min)} max=${formatNum(body.max)}${legend(row)}`
    );
    if (body.exemplar) {
      line(
        `               exemplar  value=${formatNum(body.exemplar.value)}${formatDims(body.exemplar.attrs)}`
      );
    }
  }
  for (const row of window.eventNames) {
    if (isInternal(row.name)) continue;
    line(`    event      ${row.name}  count=${row.count}`);
  }
}

const server = createIngestServer({
  host: '127.0.0.1',
  port: 0,
  projectKeys: { [PROJECT_KEY]: PROJECT },
  sink: 'memory',
  maxRequestBytes: 2097152,
  aggregateRetentionMinutes: 60,
  aggregateMaxSeriesPerMetric: 1000,
  memorySinkMaxEnvelopes: 100,
  recentClientsMax: 50,
  recentLogsMax: 100,
  projects: {
    demo: {
      version: 1,
      values: {
        'message.delayMs': 1000
      },
      keyRoles: {
        'message.delayMs': ['client']
      },
      experiments: [],
      catalog: {
        description: 'Pipeline walkthrough. See examples/pipeline.',
        roles: { client: { description: 'Walkthrough process that emits product metrics.' } },
        signals: {
          'match.completed': 'Finished matches, counted per mode',
          'coins.awarded': 'Coins granted in a window',
          'players.online': 'Last known lobby size',
          'request.duration': 'Handler duration in milliseconds',
          'matchmaking.duration': 'Time to find a match',
          'match.started': 'A match began',
          purchase: 'Completed in-app purchase',
          'message.delayMs': 'Milliseconds to wait before sending a chat message'
        },
        experiments: {}
      }
    }
  }
});

const address = await listen(server, 0, '127.0.0.1');
const endpoint = `http://127.0.0.1:${address.port}`;

banner('Wardx pipeline walkthrough');
line('One process: ingest server + SDK.');
line('Measure calls stay in memory. flush() snapshots a frame and POSTs /v1/sync.');
line('The server rolls frames into a 1-minute window. Query is the same as MCP get_aggregates.');
line(`Ingest listening on ${endpoint}`);

const wardx = createWardx({
  endpoint,
  projectKey: PROJECT_KEY,
  project: PROJECT,
  role: 'client',
  appVersion: '0.1.0',
  environment: 'development'
});
const sink = server.wardx.sink;

await wardx.flush();

banner('0. BOOTSTRAP  (empty sync, Remote Config comes down)');
line('createWardx POSTs immediately so the client can fetch the snapshot.');
line('Product metrics are still empty. The response can include config when versions differ.');
line('');
for (let i = 0; i < sink.envelopes.length; i++) printEnvelope(sink.envelopes[i], i);
line(`Remote Config after bootstrap: message.delayMs=${wardx.config.get('message.delayMs', -1)}`);

banner('1. REGISTER  (hot path — memory only, no I/O)');
line('Each call updates a series in the SDK. Nothing is sent yet.');
line('Same name + same dimensions = one series. Different dimensions = another series.');
line('');

line('  counter  match.completed {mode:ranked}  inc() × 3');
const ranked = wardx.counter('match.completed', { mode: 'ranked' });
ranked.inc();
ranked.inc();
ranked.inc();

line('  counter  match.completed {mode:casual}  inc() × 2');
wardx.counter('match.completed', { mode: 'casual' }).inc();
wardx.counter('match.completed', { mode: 'casual' }).inc();

line('  counter  coins.awarded  add(25)');
wardx.counter('coins.awarded').add(25);

line('  gauge    players.online  set(8) then set(12)  → frame keeps the last value');
wardx.gauge('players.online').set(8);
wardx.gauge('players.online').set(12);

line('  histogram request.duration  observe(5, 12, 42, 80)');
const latency = wardx.histogram('request.duration', { buckets: [10, 25, 50, 100, 250] });
for (const sample of [5, 12, 42, 80]) latency.observe(sample);

line('  timer     matchmaking.duration  start → 18ms → stop');
const endTimer = wardx.timer('matchmaking.duration');
await new Promise((resolve) => setTimeout(resolve, 18));
endTimer({ result: 'success' });

line('  event     match.started');
wardx.event('match.started', { mode: 'ranked', country: 'AR' });

line('  event     purchase');
wardx.event('purchase', { product: 'premium' });

line('  log       info match_started');
wardx.log.info('match_started', { mode: 'ranked', players: 4 });

banner('2. CLIENT AGGREGATE + TRANSMIT  (flush → snapshot → gzip → POST /v1/sync)');
line('The SDK folds the window into compact arrays. Counters are deltas, not lifetime totals.');
line('3 × inc(ranked) becomes one row with delta=3. Two gauge.set calls become last=12.');
line('');

const beforeFirst = sink.envelopes.length;
await wardx.flush();
for (let i = beforeFirst; i < sink.envelopes.length; i++) {
  printEnvelope(sink.envelopes[i], i);
}

banner('3. SECOND WINDOW  (another flush in the same minute)');
line('Counters reset after each snapshot. This flush sends a new delta.');
line('The server will sum both deltas inside the same 1-minute window: ranked 3 + 2 = 5.');
line('');
line('  counter  match.completed {mode:ranked}  inc() × 2');
ranked.inc();
ranked.inc();

const beforeSecond = sink.envelopes.length;
await wardx.flush();
for (let i = beforeSecond; i < sink.envelopes.length; i++) {
  printEnvelope(sink.envelopes[i], i);
}

banner('4. QUERY  (same payload as MCP tool get_aggregates)');
line('HTTP has no admin API. An agent calls get_aggregates on this process.');
line('executeTool() is that handler, used here so you can see the windows in stdout.');
line('');

const aggregates = executeTool(server.wardx.control, 'get_aggregates', {
  project: PROJECT,
  names: [
    'match.completed',
    'coins.awarded',
    'players.online',
    'request.duration',
    'matchmaking.duration',
    'match.started',
    'purchase'
  ]
});
for (const window of aggregates.windows) printQueryWindow(window);

const overview = executeTool(server.wardx.control, 'get_project_overview', {
  project: PROJECT,
  limit: 8
});
line('');
line('  get_project_overview  (what an agent reads first)');
line(`  project=${overview.project}  version=${overview.version}  ${overview.description}`);
for (const [role, slice] of Object.entries(overview.roles)) {
  line(`  role=${role}  ${slice.description}`);
  for (const outcome of slice.outcomes) {
    if (isInternal(outcome.name)) continue;
    if (outcome.kind === 'counter') {
      line(`    ${outcome.kind.padEnd(8)} ${outcome.name}${formatDims(outcome.dims)}  = ${outcome.value}`);
    } else {
      line(`    ${outcome.kind.padEnd(8)} ${outcome.name}  count=${outcome.count}`);
    }
  }
}

line('');
line('Read it this way:');
line('  register   → series live in SDK memory');
line('  aggregate  → snapshot folds a window into one frame (client), then into a minute (server)');
line('  transmit   → gzip JSON on POST /v1/sync, at-most-once');
line('  query      → MCP get_aggregates / get_project_overview, not HTTP');

await wardx.shutdown();
await new Promise((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
});
