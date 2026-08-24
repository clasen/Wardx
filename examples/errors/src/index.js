import { gzipSync } from 'node:zlib';
import { createIngestServer, executeTool, listen } from '@wardx/server';
import { createWardx } from 'wardx';

const PROJECT = 'demo';
const PROJECT_KEY = 'dev_project_key';
const PRIVACY_SALT = 'demo-subject-hash-v1';
const STACK_MAX = 4096;

const FAILURES = [
  { code: 'timeout', message: 'provider timed out', count: 41 },
  { code: 'card_declined', message: 'card was declined', count: 28 },
  { code: 'insufficient_funds', message: 'insufficient funds', count: 17 },
  { code: 'provider_unavailable', message: 'provider unavailable', count: 9 },
  { code: 'idempotency_conflict', message: 'repeat charge id', count: 5 }
];

class PaymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

function stripeCharge(code, message) {
  throw new PaymentError(code, message);
}

function paymentService(code, message) {
  stripeCharge(code, message);
}

function charge(code, message) {
  paymentService(code, message);
}

function clipStack(err, max = STACK_MAX) {
  const stack = err instanceof Error ? err.stack : String(err);
  if (!stack) return null;
  return stack.length <= max ? stack : stack.slice(0, max);
}

function recordFailure(wardx, err) {
  wardx.counter('payment.error', { code: err.code || 'unknown' }).inc();
  wardx.log.error('payment_failed', {
    name: err.name,
    code: err.code || 'unknown',
    stack: clipStack(err)
  });
}

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

function legend(row) {
  return row.description ? `  — ${row.description}` : row.undescribed ? '  — undescribed' : '';
}

function isInternal(name) {
  return typeof name === 'string' && name.startsWith('wardx.internal.');
}

function indentStack(stack, prefix = '               ') {
  return String(stack)
    .split('\n')
    .map((row) => `${prefix}${row}`)
    .join('\n');
}

function printLogRow(row, { stack } = {}) {
  const [, level, message, attrs] = row;
  const code = attrs && attrs.code ? attrs.code : '';
  const name = attrs && attrs.name ? attrs.name : '';
  line(`    log        ${level} ${message}${formatDims({ name, code })}`);
  if (stack && attrs && typeof attrs.stack === 'string') {
    line(indentStack(attrs.stack));
  }
}

const server = createIngestServer({
  host: '127.0.0.1',
  port: 0,
  projectKeys: { [PROJECT_KEY]: PROJECT },
  sink: 'memory',
  maxRequestBytes: 2097152,
  maxClockSkewMs: 300000,
  maxFramesPerEnvelope: 256,
  maxItemsPerEnvelope: 10000,
  maxNameBytes: 256,
  maxDimensionKeys: 8,
  maxDimensionValueLength: 64,
  maxAttributeKeys: 32,
  maxAttributeValueLength: 1024,
  persistenceFlushIntervalMs: 250,
  diagnostics: { sink: 'stderr' },
  aggregateRetentionMinutes: 60,
  aggregateMaxSeriesPerMetric: 1000,
  memorySinkMaxEnvelopes: 100,
  recentClientsMax: 50,
  recentLogsMax: 100,
  projects: {
    demo: {
      version: 1,
      values: {},
      keyRoles: {},
      experiments: [],
      catalog: {
        description: 'Checkout. Failed charges are counted and logged with a clipped stack.',
        roles: { client: { description: 'Checkout process that records failed charges.' } },
        signals: {
          'payment.error': 'Failed charge attempts, dimensioned by provider error code',
          payment_failed: 'One failed charge with name, code, and clipped stack'
        },
        experiments: {}
      }
    }
  }
});

const address = await listen(server, 0, '127.0.0.1');
const endpoint = `http://127.0.0.1:${address.port}`;

banner('Wardx error logs with stack traces');
line('One process: ingest server + SDK.');
line('Each failure increments payment.error and buffers log.error payment_failed with a clipped stack.');
line(`Ingest listening on ${endpoint}`);

const wardx = createWardx({
  endpoint,
  projectKey: PROJECT_KEY,
  project: PROJECT,
  role: 'client',
  appVersion: '0.1.0',
  environment: 'development',
  privacySalt: PRIVACY_SALT
});
const sink = server.wardx.sink;

await wardx.flush();

const expected = FAILURES.reduce((sum, row) => sum + row.count, 0);

banner('1. REGISTER  (hot path — throw, catch, memory only)');
line(`Simulated charges that throw PaymentError. ${expected} failures.`);
line('counter(name, dims) is the aggregatable series. log.error carries the stack.');
line('');
for (const row of FAILURES) {
  line(`  ${String(row.count).padStart(3)} × PaymentError ${row.code}  — ${row.message}`);
  for (let i = 0; i < row.count; i++) {
    try {
      charge(row.code, row.message);
    } catch (err) {
      recordFailure(wardx, err);
    }
  }
}

banner('2. TRANSMIT  (flush → snapshot → gzip → POST /v1/sync)');
line('The frame stores each log as [ts, level, message, attrs]. attrs.stack is a string, not the Error object.');
line(`Stacks are clipped to ${STACK_MAX} characters so the batch stays under maxFrameBytes.`);
line('');

const before = sink.envelopes.length;
await wardx.flush();

for (let i = before; i < sink.envelopes.length; i++) {
  const envelope = sink.envelopes[i];
  const json = JSON.stringify(envelope);
  const gzipBytes = gzipSync(Buffer.from(json)).length;
  line(
    `  envelope #${i}  POST /v1/sync  frames=${envelope.frames.length}  json=${Buffer.byteLength(json)}B  gzip=${gzipBytes}B`
  );
  for (const frame of envelope.frames) {
    line(`  frame seq=${frame.seq}  window=${frame.to - frame.from}ms  logs=${frame.logs.length}`);
    const counters = frame.metrics.counters.filter((row) => !isInternal(row[0]));
    for (const [name, dims, value] of counters) {
      line(`    counter    ${name}${formatDims(dims)}  delta=${value}`);
    }
    const shown = 3;
    for (let n = 0; n < Math.min(shown, frame.logs.length); n++) {
      printLogRow(frame.logs[n], { stack: true });
    }
    const rest = frame.logs.length - shown;
    if (rest > 0) {
      line(`    … ${rest} more log.error rows in this frame (same shape, omitted)`);
    }
  }
}

banner('3. QUERY  (same payload as MCP get_aggregates / get_project_overview)');
line('HTTP has no admin API. An agent sees counters and a log count. It does not see stacks.');
line('');

const aggregates = executeTool(server.wardx.control, 'get_aggregates', {
  project: PROJECT,
  names: ['payment.error']
});
for (const window of aggregates.windows) {
  line(
    `  minute ${new Date(window.from).toISOString()}  frames=${window.frames} events=${window.events} logs=${window.logs}`
  );
  for (const row of window.counters) {
    if (isInternal(row.name)) continue;
    line(`    counter    ${row.name}${formatDims(row.dims)}  = ${row.value}${legend(row)}`);
  }
}

const overview = executeTool(server.wardx.control, 'get_project_overview', {
  project: PROJECT,
  limit: 8
});
line('');
line('  get_project_overview');
line(`  project=${overview.project}  ${overview.description}`);
for (const [role, slice] of Object.entries(overview.roles)) {
  line(`  role=${role}`);
  for (const outcome of slice.outcomes) {
    if (isInternal(outcome.name)) continue;
    if (outcome.kind === 'counter') {
      line(
        `    ${outcome.kind.padEnd(8)} ${outcome.name}${formatDims(outcome.dims)}  = ${outcome.value}${legend(outcome)}`
      );
    }
  }
}

banner('4. DRILL  (same payload as MCP tool get_recent_logs)');
line('get_aggregates gave the rate. get_recent_logs returns recent log rows, newest first.');
line('This example drills payment_failed. The same tool works for any message and level.');
line('');

const drilled = executeTool(server.wardx.control, 'get_recent_logs', {
  project: PROJECT,
  message: 'payment_failed',
  attrs: { code: 'timeout' },
  limit: 2
});
line(`  get_recent_logs  message=payment_failed  attrs.code=timeout  limit=2  rows=${drilled.logs.length}`);
for (const row of drilled.logs) {
  line('');
  line(
    `    log        ${row.level} ${row.message}${formatDims({ name: row.attrs?.name, code: row.attrs?.code })}`
  );
  if (row.description) line(`               ${row.description}`);
  if (row.attrs && typeof row.attrs.stack === 'string') line(indentStack(row.attrs.stack));
}

line('');
line('  one stack per code');
for (const row of FAILURES) {
  const hit = executeTool(server.wardx.control, 'get_recent_logs', {
    project: PROJECT,
    message: 'payment_failed',
    attrs: { code: row.code },
    limit: 1
  });
  if (hit.logs.length === 0) continue;
  const sample = hit.logs[0];
  line('');
  line(`    log        ${sample.level} ${sample.message}${formatDims({ code: row.code })}`);
  if (sample.attrs && typeof sample.attrs.stack === 'string') line(indentStack(sample.attrs.stack));
}

line('');
line('Read it this way:');
line('  get_aggregates     → rates (counters, events, log count)');
line('  get_recent_logs    → sample rows; this run drills payment_failed + stack');
line('  catalog.signals    → legend the agent reads on those names');
line('  role path / git    → checkout the agent opens to edit the file; Wardx does not change source');

await wardx.shutdown();
await new Promise((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
});
