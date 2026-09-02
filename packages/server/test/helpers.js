import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@wardx/core';

const temporaryDirectories = new Set();
process.once('exit', () => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporarySqlitePath() {
  const directory = mkdtempSync(join(tmpdir(), 'wardx-test-state-'));
  temporaryDirectories.add(directory);
  return join(directory, 'state.sqlite');
}

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
    credentials: {
      'test-key': {
        label: 'test-client',
        project: 'demo',
        allowedRoles: ['client', 'game-server', 'unity', 'backend', 'frontend', 'csharp', 'desktop', 'mobile'],
        trustedForDecisions: false,
        enabled: true
      }
    },
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
    sqlite: {
      path: temporarySqlitePath(),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
      busyTimeoutMs: 5000,
      walAutoCheckpointPages: 1000,
      checkpointMode: 'PASSIVE',
      maxWriteBatchRows: 1000,
      transactionTimeoutMs: 5000,
      maxPendingBatches: 32,
      maxPendingBytes: 67108864
    },
    history: {
      clockSkewAllowanceMs: 300000,
      maxAcceptedPastAgeMs: 3600000,
      aggregateHourlyRetentionHours: 720,
      aggregateDailyRetentionDays: 365,
      maxAppVersionsPerProjectRoleTier: 20,
      maxQueryBuckets: 744,
      maxQueryRows: 10000,
      compactionIntervalMs: 60000
    },
    control: {
      journalCapacity: 1000,
      maxConcurrentMcpReads: 8,
      maxPendingMcpReads: 32
    },
    mcpHttp: { enabled: false },
    capacity: { maxConcurrentSyncHandlers: 256 },
    experiments: { ledgerMaxRows: 1000000 },
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
