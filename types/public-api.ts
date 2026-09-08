import {
  INTERNAL,
  PROTOCOL_VERSION,
  WardxCore,
  assignVariant,
  subjectHash
} from '@wardx/core';
import type {
  CoreSettings,
  Experiment,
  FrameBatch,
  SyncTraceRecord
} from '@wardx/core';
import { createConsoleTracer, createWardx } from 'wardx';
import type { CreateWardxOptions, WardxNode } from 'wardx';

const options: CreateWardxOptions = {
  endpoint: 'http://127.0.0.1:3333',
  projectKey: 'consumer-key',
  project: 'consumer-project',
  role: 'backend',
  appVersion: '1.0.0',
  environment: 'test',
  privacySalt: 'consumer-privacy-salt',
  experimentStateMaxSubjects: 1000,
  tracer: {
    sync(record: SyncTraceRecord) {
      const applied: boolean | undefined = record.appliedConfig;
      void applied;
    }
  }
};

const client: WardxNode = createWardx(options);
client.identify('subject-1');
client.counter('request.completed', { route: 'sync' }).inc();
client.gauge('players.online').set(3);
client.histogram('request.duration', { buckets: [10, 25, 50], route: 'sync' }).observe(12, { request: 'r-1' });
client.distinct('shot.traffic.hids', { result: 'violating' }).add('hid-1');
client.timer('request.duration')({ route: 'sync' });
client.event('checkout.completed', { amount: 3 });
client.log.error('checkout_failed', { code: 'timeout' });
const configured: number = client.config.get('timeoutMs', 1000, { subjectId: 'subject-2' });
client.experiment.goal('checkout.completed', { subjectId: 'subject-2', value: 1 });
const flushed: Promise<void> = client.flush();
const stopped: Promise<void> = client.shutdown();

const coreSettings: CoreSettings = {
  aggregateIntervalMs: 1000,
  syncIntervalMs: 15000,
  syncJitterMin: 0.85,
  syncJitterMax: 1.15,
  maxBufferedEvents: 5000,
  maxBufferedLogs: 2000,
  maxFrameBytes: 524288,
  maxSeriesPerMetric: 1000,
  maxDimensionKeys: 8,
  maxDimensionValueLength: 64,
  experimentStateMaxSubjects: 100000,
  httpTimeoutMs: 10000,
  histogramBuckets: [10, 25, 50],
  privacySalt: 'consumer-privacy-salt'
};
const core = new WardxCore(coreSettings);
const batch: FrameBatch = core.snapshotFrame();

const experiment: Experiment = {
  id: 'checkout-v1',
  enabled: true,
  allocation: 1,
  salt: 'checkout-v1-salt',
  goalMetric: 'checkout.completed',
  variants: [{ key: 'control', weight: 1, values: { timeoutMs: 1000 } }]
};
const assignment = assignVariant(experiment, 'subject-1');
const hashed: string = subjectHash('consumer-privacy-salt', 'subject-1');
const tracer = createConsoleTracer({ stream: { write: () => true } });

// @ts-expect-error privacySalt is a mandatory public contract.
const missingPrivacySalt: CreateWardxOptions = {
  endpoint: 'http://127.0.0.1:3333',
  projectKey: 'consumer-key',
  project: 'consumer-project',
  role: 'backend',
  appVersion: '1.0.0',
  environment: 'test'
};

// @ts-expect-error goalMetric is a mandatory experiment contract.
const missingGoalMetric: Experiment = {
  id: 'invalid',
  enabled: true,
  allocation: 1,
  salt: 'invalid-salt',
  variants: []
};

void [
  PROTOCOL_VERSION,
  INTERNAL.frameRowsDropped,
  configured,
  flushed,
  stopped,
  batch,
  assignment,
  hashed,
  tracer,
  missingPrivacySalt,
  missingGoalMetric
];


const disabledClient = createWardx({ enabled: false });
disabledClient.counter('disabled.requests').inc();
void disabledClient.flush();
void disabledClient.shutdown();
