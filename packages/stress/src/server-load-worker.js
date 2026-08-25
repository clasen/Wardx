import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

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

async function run() {
  const { port, rate, durationMs } = workerData;
  const bodies = workerData.bodies.map((body) => Buffer.from(body));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
  const latencies = [];
  let errors = 0;
  let networkErrors = 0;
  let sent = 0;
  let slice = 0;
  const started = process.hrtime.bigint();
  const deadline = started + BigInt(Math.round(durationMs * 1e6));
  try {
    while (process.hrtime.bigint() < deadline) {
      const sliceStarted = process.hrtime.bigint();
      const batchSize = Math.max(1, Math.round((rate * SLICE_MS) / 1000));
      const body = bodies[Math.min(slice, bodies.length - 1)];
      const results = await Promise.all(
        Array.from({ length: batchSize }, () => postGzip(agent, port, body))
      );
      for (const result of results) {
        sent += 1;
        latencies.push(result.ns);
        if (result.status !== 200) errors += 1;
        if (result.networkError) networkErrors += 1;
      }
      slice += 1;
      const spentMs = Number(process.hrtime.bigint() - sliceStarted) / 1e6;
      if (spentMs < SLICE_MS) await new Promise((resolve) => setTimeout(resolve, SLICE_MS - spentMs));
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    latencies.sort((left, right) => left - right);
    parentPort.postMessage({
      ok: true,
      sent,
      errors,
      networkErrors,
      elapsedMs,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99)
    });
  } finally {
    agent.destroy();
  }
}

run().catch((error) => {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.stack : String(error) });
});
