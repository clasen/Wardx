const CONFIG_KEYS = [
  'endpoint',
  'intervalMs',
  'requestTimeoutMs',
  'maxResponseBytes',
  'failureThreshold',
  'recoveryThreshold',
  'webhookUrlEnvironmentVariable',
  'webhookTimeoutMs'
];

function httpUrl(value, field) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new Error(`monitor ${field} must be an HTTP(S) URL without user information`);
  }
}

export function validateMonitorConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('monitor config must be an object');
  }
  if (Object.keys(value).some((key) => !CONFIG_KEYS.includes(key))) {
    throw new Error('monitor config contains an unknown field');
  }
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`monitor config requires ${key}`);
  }
  const config = { ...value, endpoint: httpUrl(value.endpoint, 'endpoint') };
  for (const key of CONFIG_KEYS.filter((key) => key !== 'endpoint' && key !== 'webhookUrlEnvironmentVariable')) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new Error(`monitor ${key} must be a positive safe integer`);
    }
    if (key.endsWith('Ms') && config[key] > 2_147_483_647) {
      throw new Error(`monitor ${key} exceeds the timer range`);
    }
  }
  if (typeof config.webhookUrlEnvironmentVariable !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.webhookUrlEnvironmentVariable)) {
    throw new Error('monitor webhookUrlEnvironmentVariable must be an environment variable name');
  }
  return Object.freeze(config);
}

async function readBoundedJson(response, maxBytes) {
  if (!response.body) throw new Error('missing response body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('response body exceeds limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function isReady(status, body) {
  if (![200, 503].includes(status) || !body || typeof body.ok !== 'boolean' ||
      !body.checks || typeof body.checks !== 'object' || Array.isArray(body.checks)) return false;
  const checks = Object.values(body.checks);
  if (checks.length === 0 || checks.some((value) => typeof value !== 'boolean')) return false;
  return status === 200 && body.ok && checks.every((value) => value);
}

export class ReadinessMonitor {
  constructor(config, environment = process.env) {
    this.config = validateMonitorConfig(config);
    this.webhookUrl = httpUrl(environment[this.config.webhookUrlEnvironmentVariable], 'webhook URL');
    this.status = 'healthy';
    this.deliveredStatus = 'healthy';
    this.failures = 0;
    this.recoveries = 0;
    this.inFlight = null;
    this.controller = null;
    this.closed = false;
  }

  async _request(url, timeoutMs, options, read) {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
      return await read(response);
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      clearTimeout(timer);
      this.controller = null;
    }
  }

  check() {
    if (this.closed) return Promise.reject(new Error('monitor is closed'));
    if (!this.inFlight) {
      this.inFlight = this._check().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async _check() {
    let ready;
    try {
      ready = await this._request(this.config.endpoint, this.config.requestTimeoutMs, {
        method: 'GET', headers: { accept: 'application/json' }
      }, async (response) => isReady(response.status, await readBoundedJson(response, this.config.maxResponseBytes)));
    } catch {
      ready = false;
    }
    if (this.closed) return { status: this.status, notification: 'none' };
    this.failures = ready ? 0 : Math.min(this.failures + 1, this.config.failureThreshold);
    this.recoveries = ready ? Math.min(this.recoveries + 1, this.config.recoveryThreshold) : 0;
    if (this.failures >= this.config.failureThreshold) this.status = 'degraded';
    if (this.recoveries >= this.config.recoveryThreshold) this.status = 'healthy';
    if (this.status === this.deliveredStatus) return { status: this.status, notification: 'none' };

    let delivered;
    try {
      delivered = await this._request(this.webhookUrl, this.config.webhookTimeoutMs, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'wardx.readiness', status: this.status === 'healthy' ? 'recovered' : 'degraded' })
      }, (response) => response.status >= 200 && response.status < 300);
    } catch {
      delivered = false;
    }
    if (delivered) this.deliveredStatus = this.status;
    return { status: this.status, notification: delivered ? 'sent' : 'failed' };
  }

  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.inFlight;
  }
}
