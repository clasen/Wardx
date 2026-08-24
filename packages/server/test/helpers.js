import { gzipSync } from 'node:zlib';
import { PROTOCOL_VERSION } from '@wardx/core';

export function keyRolesFor(values, roles = ['client']) {
  const keyRoles = {};
  for (const key of Object.keys(values)) keyRoles[key] = [...roles];
  return keyRoles;
}

export function testServerConfig(overrides = {}) {
  const values = {
    'message.delayMs': 1000,
    'chat.enabled': true
  };
  return {
    host: '127.0.0.1',
    port: 0,
    projectKeys: { 'test-key': 'demo' },
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
    diagnostics: { sink: 'none' },
    aggregateRetentionMinutes: 60,
    aggregateMaxSeriesPerMetric: 1000,
    memorySinkMaxEnvelopes: 1000,
    recentClientsMax: 50,
    recentLogsMax: 100,
    projects: {
      demo: {
        version: 12,
        values,
        keyRoles: keyRolesFor(values),
        experiments: []
      }
    },
    ...overrides
  };
}

export function gzipJson(object) {
  return gzipSync(Buffer.from(JSON.stringify(object)));
}

export function sampleEnvelope(overrides = {}) {
  const now = Date.now();
  const { client, ...rest } = overrides;
  return {
    protocol: PROTOCOL_VERSION,
    project: 'demo',
    sdk: { name: 'wardx-node', version: '0.1.0' },
    client: {
      instanceId: '01TESTINSTANCE000000000000',
      sessionId: '01TESTSESSION0000000000000',
      role: 'client',
      appVersion: '0.0.0',
      environment: 'test',
      platform: 'node',
      ...client
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
    ...rest
  };
}
