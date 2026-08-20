import http from 'node:http';
import { gzipJson, sampleEnvelope, testServerConfig } from '../../server/test/helpers.js';
import { createIngestServer, listen } from '@wardx/server';
import { report, startEventLoopProbe } from './measure.js';

export async function testF({ durationMs, rate }) {
  const config = testServerConfig({ sink: 'null', port: 0 });
  const server = createIngestServer(config);
  const address = await listen(server, 0, '127.0.0.1');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  const loop = startEventLoopProbe();
  let seen13 = 0;
  let seen12 = 0;
  let errors = 0;
  const started = Date.now();
  const bumpAt = started + durationMs / 3;

  async function sync(configVersion) {
    const body = gzipJson(sampleEnvelope({ configVersion, frames: [] }));
    return await new Promise((resolve, reject) => {
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
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  let bumped = false;
  while (Date.now() - started < durationMs) {
    if (!bumped && Date.now() >= bumpAt) {
      await new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          version: 13,
          values: { 'message.delayMs': 400 },
          experiments: []
        });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/v1/admin/config',
            method: 'PUT',
            agent,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'x-wardx-admin-key': 'admin-key'
            }
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      bumped = true;
    }
    const version = bumped ? 12 : 12;
    const batch = [];
    for (let i = 0; i < Math.min(rate, 100); i++) {
      batch.push(
        sync(version)
          .then((result) => {
            if (result.status !== 200) errors += 1;
            else if (result.json.configVersion === 13) seen13 += 1;
            else seen12 += 1;
          })
          .catch(() => {
            errors += 1;
          })
      );
    }
    await Promise.all(batch);
  }
  const loopStats = loop.stop();
  agent.destroy();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  report('F remote config storm', {
    seen12,
    seen13,
    errors,
    bumped,
    'event-loop p99 ms': loopStats.p99Ms.toFixed(3)
  });
  if (!bumped || seen13 === 0) throw new Error('config storm did not publish version 13');
  return { seen12, seen13, errors, loopStats };
}
