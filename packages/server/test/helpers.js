import { gzipSync } from 'node:zlib';
import { PROTOCOL_VERSION } from '@wardx/core';

export function testServerConfig(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    projectKeys: { 'test-key': 'demo' },
    adminKey: 'admin-key',
    sink: 'memory',
    maxRequestBytes: 2097152,
    aggregateRetentionMinutes: 60,
    memorySinkMaxEnvelopes: 1000,
    config: {
      version: 12,
      values: {
        'message.delayMs': 1000,
        'chat.enabled': true
      },
      experiments: []
    },
    ...overrides
  };
}

export function gzipJson(object) {
  return gzipSync(Buffer.from(JSON.stringify(object)));
}

export function sampleEnvelope(overrides = {}) {
  const now = Date.now();
  return {
    protocol: PROTOCOL_VERSION,
    project: 'demo',
    sdk: { name: 'wardx-node', version: '0.1.0' },
    client: {
      instanceId: '01TESTINSTANCE000000000000',
      sessionId: '01TESTSESSION0000000000000',
      appVersion: '0.0.0',
      environment: 'test',
      platform: 'node'
    },
    configVersion: 0,
    frames: [
      {
        seq: 1,
        from: now - 1000,
        to: now,
        metrics: {
          counters: [['match.completed', { mode: 'ranked' }, 4]],
          gauges: [['players.online', null, 9, now]],
          histograms: []
        },
        events: [[now - 800, 'purchase', { product: 'premium' }]],
        logs: [[now - 700, 'error', 'payment_failed', { code: 'timeout' }]]
      }
    ],
    ...overrides
  };
}
