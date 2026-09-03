import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnvelope, validateExperimentEvents } from '../src/ingest/validate.js';
import { sampleEnvelope, testServerConfig } from './helpers.js';
import { HyperLogLog } from '@wardx/core';

const LIMITS = testServerConfig();

function mutateEnvelope(mutator) {
  const envelope = sampleEnvelope();
  mutator(envelope);
  return envelope;
}

test('validateEnvelope accepts the documented wire structures', () => {
  const to = Date.now();
  const from = to - 15_000;
  const envelope = {
    protocol: 1,
    project: 'demo',
    sdk: { name: 'wardx-node', version: '0.1.0' },
    client: {
      instanceId: '01…',
      sessionId: '01…',
      role: 'client',
      appVersion: '2.4.1',
      environment: 'production',
      platform: 'node'
    },
    configVersion: 12,
    frames: [
      {
        seq: 42,
        from,
        to,
        metrics: {
          counters: [['match.completed', { mode: 'ranked' }, 18392]],
          gauges: [['players.online', null, 12921, to - 1000]],
          histograms: [
            [
              'request.duration',
              null,
              {
                count: 10,
                sum: 420,
                min: 3,
                max: 80,
                buckets: [
                  [10, 2],
                  [25, 5],
                  [50, 2]
                ],
                exemplar: { value: 80, attrs: { grantId: 'g-80' } }
              }
            ]
          ],
          distincts: [[
            'shot.traffic.hids',
            { result: 'violating' },
            (() => {
              const hll = new HyperLogLog('shot.traffic.hids', null, 'test-salt');
              hll.add('private-hid');
              return hll.snapshot();
            })()
          ]]
        },
        events: [[from + 4812, 'purchase', { product: 'premium' }]],
        logs: [[from + 5823, 'error', 'payment_failed', { code: 'timeout' }]]
      }
    ]
  };
  assert.equal(
    validateEnvelope(envelope, {
      ...LIMITS,
      history: { ...LIMITS.history, maxAcceptedPastAgeMs: 10 * 86_400_000 }
    }),
    null
  );
});

test('validateEnvelope rejects malformed HLL sketches', () => {
  const cases = [
    [{ precision: 8, registers: '' }, /precision must be 9/],
    [{ precision: 9, registers: 'not-base64' }, /canonical base64/],
    [{ precision: 9, registers: Buffer.alloc(511).toString('base64') }, /exactly 512 bytes/],
    [{ precision: 9, registers: Buffer.from([57, ...new Array(511).fill(0)]).toString('base64') }, /rank must be <= 56/]
  ];
  for (const [body, expected] of cases) {
    const envelope = sampleEnvelope();
    envelope.frames[0].metrics.distincts = [['active.hids', null, body]];
    assert.match(validateEnvelope(envelope, LIMITS), expected);
  }
});

test('validateEnvelope accepts configured limits exactly', () => {
  const exactName = 'é'.repeat(LIMITS.maxNameBytes / 2);
  const exactDimensions = Object.fromEntries(
    Array.from({ length: LIMITS.maxDimensionKeys }, (_, index) => [`d${index}`, 'x'.repeat(LIMITS.maxDimensionValueLength)])
  );
  const exactAttrs = Object.fromEntries(
    Array.from({ length: LIMITS.maxAttributeKeys }, (_, index) => [`a${index}`, 'x'.repeat(LIMITS.maxAttributeValueLength)])
  );
  const frame = sampleEnvelope().frames[0];
  frame.metrics.counters = [[exactName, exactDimensions, 1]];
  frame.metrics.gauges = [];
  frame.events = [[Date.now(), exactName, exactAttrs]];
  frame.logs = [];

  const envelope = sampleEnvelope({
    project: exactName,
    frames: [
      frame,
      ...Array.from({ length: LIMITS.maxFramesPerEnvelope - 1 }, (_, index) => ({
        seq: index + 2,
        from: frame.from,
        to: frame.to,
        metrics: { counters: [], gauges: [], histograms: [] },
        events: [],
        logs: []
      }))
    ]
  });
  assert.equal(validateEnvelope(envelope, { ...LIMITS, maxItemsPerEnvelope: LIMITS.maxFramesPerEnvelope * 2 }), null);

  const exactItems = sampleEnvelope();
  exactItems.frames[0].metrics.counters = Array.from({ length: LIMITS.maxItemsPerEnvelope }, () => ['c', null, 1]);
  exactItems.frames[0].metrics.gauges = [];
  exactItems.frames[0].events = [];
  exactItems.frames[0].logs = [];
  assert.equal(validateEnvelope(exactItems, LIMITS), null);
});

test('validateEnvelope rejects malformed scalar and tuple fields', () => {
  const cases = [
    ['non-object body', () => null, /body must be an object/],
    ['invalid protocol', (body) => (body.protocol = 2), /protocol must be 1/],
    ['empty project', (body) => (body.project = ''), /project/],
    ['missing sdk', (body) => delete body.sdk, /sdk is required/],
    ['empty sdk name', (body) => (body.sdk.name = ''), /sdk\.name/],
    ['missing sdk version', (body) => delete body.sdk.version, /sdk\.version/],
    ['oversized sdk version', (body) => (body.sdk.version = 'v'.repeat(LIMITS.maxNameBytes + 1)), /UTF-8 bytes/],
    ['missing client', (body) => delete body.client, /client is required/],
    ['empty instance id', (body) => (body.client.instanceId = ''), /instanceId/],
    ['missing session id', (body) => delete body.client.sessionId, /sessionId/],
    ['oversized session id', (body) => (body.client.sessionId = 's'.repeat(LIMITS.maxNameBytes + 1)), /UTF-8 bytes/],
    ['missing role', (body) => delete body.client.role, /client\.role is required/],
    ['wildcard role', (body) => (body.client.role = '*'), /cannot be \*/],
    ['missing app version', (body) => delete body.client.appVersion, /client\.appVersion/],
    ['empty environment', (body) => (body.client.environment = ''), /client\.environment/],
    ['missing platform', (body) => delete body.client.platform, /client\.platform/],
    ['oversized platform', (body) => (body.client.platform = 'p'.repeat(LIMITS.maxNameBytes + 1)), /UTF-8 bytes/],
    ['negative config version', (body) => (body.configVersion = -1), /integer >= 0/],
    ['non-array frames', (body) => (body.frames = {}), /frames must be an array/],
    ['non-object frame', (body) => (body.frames[0] = []), /frames\[0\] must be an object/],
    ['zero seq', (body) => (body.frames[0].seq = 0), /seq must be an integer/],
    ['fractional seq', (body) => (body.frames[0].seq = 1.5), /seq must be an integer/],
    ['non-finite from', (body) => (body.frames[0].from = Infinity), /finite timestamp/],
    ['non-finite to', (body) => (body.frames[0].to = NaN), /finite timestamp/],
    ['reverse frame time', (body) => (body.frames[0].from = body.frames[0].to + 1), /from must be <= to/],
    ['missing metrics', (body) => delete body.frames[0].metrics, /metrics is required/],
    ['non-array counters', (body) => (body.frames[0].metrics.counters = {}), /counters must be an array/],
    ['short counter', (body) => (body.frames[0].metrics.counters[0] = ['requests']), /3-item tuple/],
    ['empty counter name', (body) => (body.frames[0].metrics.counters[0][0] = ''), /non-empty string/],
    ['string counter', (body) => (body.frames[0].metrics.counters[0][2] = '4'), /finite number/],
    ['array dimensions', (body) => (body.frames[0].metrics.counters[0][1] = []), /object or null/],
    ['empty dimension key', (body) => (body.frames[0].metrics.counters[0][1] = { '': 'x' }), /key must be a non-empty string/],
    ['nested dimension', (body) => (body.frames[0].metrics.counters[0][1] = { route: {} }), /string, finite number, or boolean/],
    ['non-array gauges', (body) => (body.frames[0].metrics.gauges = null), /gauges must be an array/],
    ['short gauge', (body) => (body.frames[0].metrics.gauges[0] = ['players', null, 1]), /4-item tuple/],
    ['empty gauge name', (body) => (body.frames[0].metrics.gauges[0][0] = ''), /non-empty string/],
    ['array gauge dimensions', (body) => (body.frames[0].metrics.gauges[0][1] = []), /object or null/],
    ['non-finite gauge value', (body) => (body.frames[0].metrics.gauges[0][2] = Infinity), /finite number/],
    ['non-finite gauge time', (body) => (body.frames[0].metrics.gauges[0][3] = Infinity), /finite timestamp/],
    ['non-array histograms', (body) => (body.frames[0].metrics.histograms = {}), /histograms must be an array/],
    ['non-array events', (body) => (body.frames[0].events = {}), /events must be an array/],
    ['short event', (body) => (body.frames[0].events[0] = [Date.now(), 'purchase']), /3-item tuple/],
    ['non-finite event time', (body) => (body.frames[0].events[0][0] = Infinity), /finite timestamp/],
    ['empty event name', (body) => (body.frames[0].events[0][1] = ''), /non-empty string/],
    ['array event attrs', (body) => (body.frames[0].events[0][2] = []), /object or null/],
    ['empty attr key', (body) => (body.frames[0].events[0][2] = { '': true }), /key must be a non-empty string/],
    ['unsupported attr value', (body) => (body.frames[0].events[0][2] = { value: undefined }), /only JSON values/],
    ['non-finite nested attr', (body) => (body.frames[0].events[0][2] = { values: [Infinity] }), /finite numbers/],
    ['non-array logs', (body) => (body.frames[0].logs = {}), /logs must be an array/],
    ['short log', (body) => (body.frames[0].logs[0] = [Date.now(), 'error']), /4-item tuple/],
    ['non-finite log time', (body) => (body.frames[0].logs[0][0] = Infinity), /finite timestamp/],
    ['bad log level', (body) => (body.frames[0].logs[0][1] = 'fatal'), /supported log level/],
    ['empty log message', (body) => (body.frames[0].logs[0][2] = ''), /non-empty string/],
    ['array log attrs', (body) => (body.frames[0].logs[0][3] = []), /object or null/]
  ];

  for (const [name, mutate, expected] of cases) {
    const invalid = name === 'non-object body' ? validateEnvelope(null, LIMITS) : validateEnvelope(mutateEnvelope(mutate), LIMITS);
    assert.match(invalid, expected, name);
  }
});

test('validateEnvelope enforces strict keys, clock skew, names, dimensions, attrs, and collection limits', () => {
  const now = Date.now();
  const cases = [
    ['unknown envelope key', (body) => (body.extra = true), /body unknown key: extra/],
    ['unknown sdk key', (body) => (body.sdk.extra = true), /sdk unknown key: extra/],
    ['unknown client key', (body) => (body.client.extra = true), /client unknown key: extra/],
    ['unknown frame key', (body) => (body.frames[0].extra = true), /frames\[0\] unknown key: extra/],
    ['unknown metrics key', (body) => (body.frames[0].metrics.extra = []), /metrics unknown key: extra/],
    [
      'future frame',
      (body) => {
        body.frames[0].from = now + LIMITS.maxClockSkewMs + 60_000;
        body.frames[0].to = body.frames[0].from;
      },
      /maxClockSkewMs/
    ],
    [
      'future event',
      (body) => (body.frames[0].events[0][0] = now + LIMITS.maxClockSkewMs + 60_000),
      /maxClockSkewMs/
    ],
    [
      'oversized name',
      (body) => (body.frames[0].metrics.counters[0][0] = 'n'.repeat(LIMITS.maxNameBytes + 1)),
      /UTF-8 bytes/
    ],
    [
      'too many dimensions',
      (body) => {
        body.frames[0].metrics.counters[0][1] = Object.fromEntries(
          Array.from({ length: LIMITS.maxDimensionKeys + 1 }, (_, index) => [`d${index}`, index])
        );
      },
      /at most 8 keys/
    ],
    [
      'long dimension value',
      (body) => (body.frames[0].metrics.counters[0][1] = { mode: 'x'.repeat(65) }),
      /at most 64 characters/
    ],
    [
      'too many attrs',
      (body) => {
        body.frames[0].events[0][2] = Object.fromEntries(
          Array.from({ length: LIMITS.maxAttributeKeys + 1 }, (_, index) => [`a${index}`, index])
        );
      },
      /at most 32 keys/
    ],
    [
      'long attr value',
      (body) => (body.frames[0].events[0][2] = { value: 'x'.repeat(1025) }),
      /at most 1024 characters/
    ]
  ];

  for (const [name, mutate, expected] of cases) {
    assert.match(validateEnvelope(mutateEnvelope(mutate), LIMITS), expected, name);
  }

  const tooManyFrames = sampleEnvelope({
    frames: Array.from({ length: LIMITS.maxFramesPerEnvelope + 1 }, () => sampleEnvelope().frames[0])
  });
  assert.match(validateEnvelope(tooManyFrames, LIMITS), /frames must contain at most 256 items/);

  const lowItemLimit = { ...LIMITS, maxItemsPerEnvelope: 1 };
  assert.match(validateEnvelope(sampleEnvelope(), lowItemLimit), /collections must contain at most 1 items/);
});

test('validateEnvelope rejects incoherent histogram bodies', () => {
  function histogram(body) {
    return mutateEnvelope((envelope) => {
      envelope.frames[0].metrics.histograms = [['latency', null, body]];
    });
  }
  const valid = {
    count: 2,
    sum: 30,
    min: 10,
    max: 20,
    buckets: [
      [10, 1],
      [20, 1]
    ]
  };
  const cases = [
    [null, /must be an object/],
    [{ ...valid, extra: true }, /unknown key: extra/],
    [{ ...valid, count: -1 }, /count must be an integer/],
    [{ ...valid, sum: Infinity }, /sum must be a finite number/],
    [{ ...valid, min: Infinity }, /min must be a finite number/],
    [{ ...valid, max: Infinity }, /max must be a finite number/],
    [{ ...valid, min: 21 }, /min must be <= max/],
    [{ ...valid, buckets: {} }, /buckets must be an array/],
    [{ ...valid, buckets: [[10]] }, /2-item tuple/],
    [{ ...valid, buckets: [[20, 1], [10, 1]] }, /strictly increasing/],
    [{ ...valid, buckets: [[10, -1]] }, /integer >= 0/],
    [{ ...valid, buckets: [[10, 2], [20, 1]] }, /total must be <= count/],
    [{ ...valid, exemplar: [] }, /exemplar must be an object/],
    [{ ...valid, exemplar: { value: 20, attrs: null, extra: true } }, /unknown key: extra/],
    [{ ...valid, exemplar: { value: Infinity, attrs: null } }, /finite number/],
    [{ ...valid, exemplar: { value: 19, attrs: null } }, /value must equal max/],
    [{ ...valid, exemplar: { value: 20, attrs: [] } }, /object or null/]
  ];

  for (const [body, expected] of cases) {
    assert.match(validateEnvelope(histogram(body), LIMITS), expected);
  }
});

test('validateExperimentEvents accepts one matching assignment and rejects ambiguous or stale rows', () => {
  const definition = {
    id: 'delay',
    enabled: true,
    allocation: 1,
    salt: 'salt',
    roles: ['client'],
    goalMetric: 'message.sent',
    assignmentUnitKind: 'subject',
    terminalRetentionMs: 604800000,
    variants: [
      { key: 'control', weight: 50, values: {} },
      { key: 'fast', weight: 50, values: {} }
    ]
  };
  const now = Date.now();
  function withEvents(events, client) {
    return sampleEnvelope({
      client,
      frames: [
        {
          seq: 1,
          from: now - 1,
          to: now,
          metrics: { counters: [], gauges: [], histograms: [] },
          events,
          logs: []
        }
      ]
    });
  }
  const exposure = [
    now,
    'experiment.exposure',
    { experiment: 'delay', variant: 'fast', subject: 'ab'.repeat(32) }
  ];
  const goal = [
    now,
    'experiment.goal',
    {
      metric: 'message.sent',
      subject: 'ab'.repeat(32),
      experiments: [{ experiment: 'delay', variant: 'fast' }]
    }
  ];
  assert.equal(validateExperimentEvents(withEvents([exposure, goal]), [definition]), null);

  const cases = [
    [withEvents([[now, 'experiment.goal', null]]), /must be an object/],
    [withEvents([[now, 'experiment.exposure', null]]), /must be an object/],
    [withEvents([[now, 'experiment.exposure', { ...exposure[2], extra: true }]]), /unknown key: extra/],
    [withEvents([[now, 'experiment.exposure', { ...exposure[2], subject: '' }]]), /subject must be a non-empty string/],
    [withEvents([[now, 'experiment.exposure', { ...exposure[2], experiment: 'missing' }]]), /experiment is unknown/],
    [withEvents([[now, 'experiment.exposure', { ...exposure[2], variant: 'missing' }]]), /variant is unknown/],
    [withEvents([[now, 'experiment.exposure', exposure[2]]], { role: 'backend' }), /not visible to client\.role/],
    [withEvents([[now, 'experiment.goal', { ...goal[2], extra: true }]]), /unknown key: extra/],
    [withEvents([[now, 'experiment.goal', { ...goal[2], subject: '' }]]), /subject must be a non-empty string/],
    [withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [] }]]), /exactly one assignment/],
    [withEvents([[now, 'experiment.goal', { ...goal[2], value: Infinity }]]), /value must be a finite number/],
    [withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [null] }]]), /must be an object/],
    [
      withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [{ ...goal[2].experiments[0], extra: true }] }]]),
      /unknown key: extra/
    ],
    [
      withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [{ experiment: '', variant: 'fast' }] }]]),
      /experiment must be a non-empty string/
    ],
    [
      withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [{ experiment: 'delay', variant: '' }] }]]),
      /variant must be a non-empty string/
    ],
    [
      withEvents([[now, 'experiment.goal', { ...goal[2], metric: 'purchase.completed' }]]),
      /does not match experiment\.goalMetric/
    ],
    [
      withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [{ experiment: 'missing', variant: 'fast' }] }]]),
      /experiment is unknown/
    ],
    [
      withEvents([[now, 'experiment.goal', { ...goal[2], experiments: [{ experiment: 'delay', variant: 'missing' }] }]]),
      /variant is unknown/
    ],
    [withEvents([goal], { role: 'backend' }), /not visible to client\.role/]
  ];
  for (const [body, expected] of cases) assert.match(validateExperimentEvents(body, [definition]), expected);
});
