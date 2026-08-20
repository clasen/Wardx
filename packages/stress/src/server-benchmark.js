import http from 'node:http';
import { gzipJson, sampleEnvelope, testServerConfig } from '../../server/test/helpers.js';
import { createIngestServer, listen } from '@wardx/server';
import { percentile, report, startEventLoopProbe } from './measure.js';

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function postGzip(agent, port, body) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
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
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            ns: Number(process.hrtime.bigint() - t0)
          });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function testD({ rate, durationMs }) {
  const config = testServerConfig({ sink: 'null', port: 0 });
  const server = createIngestServer(config);
  const address = await listen(server, 0, '127.0.0.1');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const body = gzipJson(sampleEnvelope({ configVersion: 12 }));
  const loop = startEventLoopProbe();
  const latencies = [];
  let errors = 0;
  let sent = 0;
  const started = Date.now();
  const interval = 1000 / rate;
  while (Date.now() - started < durationMs) {
    const batchStarted = Date.now();
    const inflight = [];
    const batch = Math.min(rate, 250);
    for (let i = 0; i < batch; i++) {
      inflight.push(
        postGzip(agent, address.port, body).then((result) => {
          sent += 1;
          latencies.push(result.ns);
          if (result.status !== 200) errors += 1;
        })
      );
    }
    await Promise.all(inflight);
    const spent = Date.now() - batchStarted;
    const expected = batch * interval;
    if (spent < expected) {
      await new Promise((resolve) => setTimeout(resolve, expected - spent));
    }
  }
  const loopStats = loop.stop();
  agent.destroy();
  await closeServer(server);
  const elapsed = (Date.now() - started) / 1000;
  const p50 = percentile(latencies, 50) / 1e6;
  const p95 = percentile(latencies, 95) / 1e6;
  const p99 = percentile(latencies, 99) / 1e6;
  report(`D server ingest ${rate}/s`, {
    sent,
    'actual sync/s': (sent / elapsed).toFixed(1),
    'error rate': `${((errors / sent) * 100).toFixed(4)}%`,
    'p50 ms': p50.toFixed(2),
    'p95 ms': p95.toFixed(2),
    'p99 ms': p99.toFixed(2),
    'event-loop p99 ms': loopStats.p99Ms.toFixed(3),
    rss: process.memoryUsage().rss
  });
  return { sent, errors, p50, p95, p99, loopStats };
}
