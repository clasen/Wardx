import http from 'node:http';

// Runs in its own process so load generation does not share CPU with the
// server under test. A fixed pool of keep-alive connections paces requests on
// a schedule, so a saturated server lowers the achieved rate instead of the
// client opening sockets beyond the OS listen backlog.
const SLICE_MS = 50;

function postGzip(agent, port, body) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/sync',
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': body.length,
          'x-wardx-key': 'test-key'
        }
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({
          status: res.statusCode,
          ns: Number(process.hrtime.bigint() - started),
          networkError: false
        }));
      }
    );
    req.on('error', () => resolve({
      status: 0,
      ns: Number(process.hrtime.bigint() - started),
      networkError: true
    }));
    req.end(body);
  });
}

function percentile(values, percentage) {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((percentage / 100) * values.length) - 1));
  return values[index] / 1e6;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run({ port, rate, durationMs, connections, bodies }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
  const latencies = [];
  let errors = 0;
  let networkErrors = 0;
  let sent = 0;
  let scheduled = 0;
  const intervalNs = 1e9 / rate;
  const started = process.hrtime.bigint();
  const deadline = started + BigInt(Math.round(durationMs * 1e6));
  const connection = async () => {
    for (;;) {
      const dueNs = started + BigInt(Math.round(scheduled * intervalNs));
      if (dueNs >= deadline || process.hrtime.bigint() >= deadline) return;
      scheduled += 1;
      const waitMs = Number(dueNs - process.hrtime.bigint()) / 1e6;
      if (waitMs > 1) await sleep(waitMs);
      const slice = Math.floor(Number(dueNs - started) / 1e6 / SLICE_MS);
      const result = await postGzip(agent, port, bodies[Math.min(slice, bodies.length - 1)]);
      sent += 1;
      latencies.push(result.ns);
      if (result.status !== 200) errors += 1;
      if (result.networkError) networkErrors += 1;
    }
  };
  try {
    await Promise.all(Array.from({ length: connections }, connection));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    latencies.sort((left, right) => left - right);
    return {
      ok: true,
      sent,
      errors,
      networkErrors,
      elapsedMs,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99)
    };
  } finally {
    agent.destroy();
  }
}

process.once('message', (input) => {
  run({ ...input, bodies: input.bodies.map((body) => Buffer.from(body)) })
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.stack : String(error) }))
    .then((result) => process.send(result, () => process.disconnect()));
});
