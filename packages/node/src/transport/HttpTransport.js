import http from 'node:http';
import https from 'node:https';

function syncUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1/sync';
  }
  return url;
}

export function createHttpTransport({ endpoint, projectKey, httpTimeoutMs }) {
  const url = syncUrl(endpoint);
  const lib = url.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true });

  return {
    post(gzippedBody) {
      return new Promise((resolve, reject) => {
        const req = lib.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            agent,
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': gzippedBody.length,
              'x-wardx-key': projectKey,
              accept: 'application/json'
            }
          },
          (res) => {
            const chunks = [];
            res.on('error', reject);
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              const text = buf.length === 0 ? '{}' : buf.toString('utf8');
              let json;
              try {
                json = JSON.parse(text);
              } catch {
                resolve({ ok: false, status: res.statusCode, json: null, text });
                return;
              }
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                json,
                text
              });
            });
          }
        );
        const deadline = setTimeout(() => {
          req.destroy(new Error('wardx sync timed out'));
        }, httpTimeoutMs);
        req.once('close', () => clearTimeout(deadline));
        req.on('error', reject);
        req.write(gzippedBody);
        req.end();
      });
    },
    close() {
      agent.destroy();
    }
  };
}
