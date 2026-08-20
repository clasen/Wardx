import http from 'node:http';
import { gzipJson, sampleEnvelope, testServerConfig } from '../../server/test/helpers.js';
import { createIngestServer, listen } from '@wardx/server';
import { report, startEventLoopProbe } from './measure.js';

function nextDelay(syncIntervalMs) {
  return syncIntervalMs * (0.85 + Math.random() * 0.3);
}

export async function testE({ clients, durationMs, syncIntervalMs }) {
  const config = testServerConfig({ sink: 'null', port: 0 });
  const server = createIngestServer(config);
  const address = await listen(server, 0, '127.0.0.1');
  const agent = new http.Agent({ keepAlive: true, maxSockets: Math.min(clients, 1024) });
  const bodies = Array.from({ length: 8 }, (_, i) =>
    gzipJson(
      sampleEnvelope({
        configVersion: 12,
        client: {
          instanceId: `client-${i}`,
          sessionId: `session-${i}`,
          appVersion: '0.0.0',
          environment: 'stress',
          platform: 'node'
        }
      })
    )
  );
  const loop = startEventLoopProbe();
  let sent = 0;
  let errors = 0;
  let running = true;
  const workers = [];
  const perWorker = Math.max(1, Math.ceil(clients / 32));
  const workerCount = Math.ceil(clients / perWorker);
  for (let w = 0; w < workerCount; w++) {
    const n = Math.min(perWorker, clients - w * perWorker);
    workers.push(
      (async () => {
        const timers = [];
        for (let i = 0; i < n; i++) {
          const body = bodies[(w + i) % bodies.length];
          const tick = async () => {
            if (!running) return;
            await new Promise((resolve, reject) => {
              const req = http.request(
                {
                  hostname: '127.0.0.1',
                  port: address.port,
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
                    sent += 1;
                    if (res.statusCode !== 200) errors += 1;
                    resolve();
                  });
                }
              );
              req.on('error', (err) => {
                errors += 1;
                reject(err);
              });
              req.write(body);
              req.end();
            }).catch(() => {});
            if (running) {
              const t = setTimeout(tick, nextDelay(syncIntervalMs));
              t.unref();
              timers.push(t);
            }
          };
          const start = setTimeout(tick, Math.random() * syncIntervalMs);
          start.unref();
          timers.push(start);
        }
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        for (const t of timers) clearTimeout(t);
      })()
    );
  }
  await Promise.all(workers);
  running = false;
  const loopStats = loop.stop();
  agent.destroy();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  report(`E fleet ${clients} clients / ${syncIntervalMs}ms`, {
    sent,
    errors,
    'approx sync/s': (sent / (durationMs / 1000)).toFixed(1),
    'event-loop p99 ms': loopStats.p99Ms.toFixed(3),
    rss: process.memoryUsage().rss
  });
  return { sent, errors, loopStats };
}
