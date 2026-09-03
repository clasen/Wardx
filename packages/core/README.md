# @wardx/core

`@wardx/core` is the runtime-agnostic engine of Wardx.

The engine records metrics, events, and logs in memory. The engine also stores Remote Config and assigns experiment variants.

## Install

```bash
npm install @wardx/core
```

```js
import { WardxCore, assignVariant, loadSdkDefaults } from '@wardx/core';
```

> [!NOTE]
> **Agent skill.** Teach the agent the Node SDK (this engine lives inside it) with the [Skills CLI](https://skills.sh):
>
> ```bash
> npx skills add https://github.com/clasen/Wardx --skill wardx
> ```

## Design rules

- A measure call changes local memory only.
- A measure call does not send network data.
- A measure call does not wait for a Promise.
- If a buffer is full, the engine discards data. The engine does not block the application.
- Counters in a frame are window deltas. Counters are not lifetime totals.
- `identify(subjectId)` sets the default subject for this instance. A per-call `{ subjectId }` overrides it.

## Settings

`WardxCore` needs a settings object. Use `loadSdkDefaults()` and add the identity fields.

| Key | Description |
| --- | --- |
| `endpoint` | Sync URL. The core does not use this key. Runtimes use this key. |
| `projectKey` | Project credential. Runtimes send this key. It is never reused as the subject-hash salt. |
| `project` | Project name. |
| `role` | Runtime identity inside the project. Runtimes send this name. The core does not use this key. |
| `appVersion` | Application version. |
| `environment` | Environment name, for example `production`. |
| `privacySalt` | Required stable, non-empty, project-specific salt for one-way subject hashes. |
| `aggregateIntervalMs` | Default `1000`. Interval to snapshot dirty data. |
| `syncIntervalMs` | Default `15000`. Interval for the runtime sync. |
| `maxBufferedEvents` | Default `5000`. |
| `maxBufferedLogs` | Default `2000`. |
| `maxFrameBytes` | Default `524288`; must be at least `1024`. |
| `maxSeriesPerMetric` | Default `1000`. |
| `maxDimensionKeys` | Default `8`. |
| `maxDimensionValueLength` | Default `64`. |
| `experimentStateMaxSubjects` | Default `100000`. Maximum subjects retained for assignment/exposure state in this SDK instance. |
| `histogramBuckets` | Default `[10, 25, 50, 100, 250, 500, 1000]`. |
| `tracer` | Optional. Duck-typed local hook with any of `measure`, `event`, `log`, `frame`. The core does not print. Runtimes may also call `sync`. |

The defaults live in `defaults.json`. Do not omit a required key. The loader does not add a fallback for a missing key. `tracer` is not a default key. Omit it to keep the measure path unchanged. The project key authenticates only the project; `role` is client-selected routing metadata, not authorization. Never put secrets in Remote Config.

## Use case 1: Record metrics in a custom runtime

**When:** You write a runtime that is not Node.js, or you test the engine without HTTP.

**Objective:** Record counters, gauges, histograms, distinct estimates, and timers. Then make a frame.

```js
import { WardxCore, loadSdkDefaults } from '@wardx/core';

const settings = {
  ...loadSdkDefaults(),
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'client',
  appVersion: '0.1.0',
  environment: 'development',
  privacySalt: 'demo-subject-hash-v1'
};

const core = new WardxCore(settings);

core.counter('match.completed', { mode: 'ranked' }).inc();
core.counter('coins.awarded').add(25);
core.gauge('players.online').set(12921);
core.histogram('request.duration').observe(42);
core.distinct('shot.traffic.hids', { result: 'violating' }).add(hid);

const endTimer = core.timer('matchmaking.duration');
endTimer({ result: 'success' });

const batch = core.snapshotFrame();
const frames = core.takePendingFrames();
```

### Procedure

1. Load the SDK defaults.
2. Add the identity fields.
3. Construct `WardxCore`.
4. Call `counter`, `gauge`, `histogram`, `distinct`, or `timer`.
5. Call `snapshotFrame` when you need a frame.
6. Call `takePendingFrames` to get the pending frames.

`counter(name, dims).inc()` adds `1`. `add(n)` adds a finite number `n`.

`gauge(name, dims).set(value)` stores the last finite value and a timestamp.

`histogram(name).observe(value)` records a finite value into buckets. You can set buckets:

```js
core.histogram('request.duration', { buckets: [10, 25, 50, 100] }).observe(42);
core.histogram('coins.award_size').observe(80, { grantId: 'g-80' });
```

`observe(value, attrs)` keeps `attrs` only when `value` is the window max. The frame stores that pair as `exemplar`. Attrs use the same key and value limits as dimensions. Do not change the buckets of an existing series. The engine throws an error.

`timer(name, dims)` starts a timer. The returned function records the duration in milliseconds into a histogram. You can add dimensions when you stop the timer.

`distinct(name, dims).add(identifier)` updates a fixed HyperLogLog sketch. The
engine hashes the identifier as `SHA-256(privacySalt || 0x00 || identifier)` and
discards it immediately; the frame contains only 512 HLL registers (`p=9`,
about 4.6% standard error). Keep `privacySalt` stable across workers and time
windows so equal identifiers map to equal registers.

If a series is above `maxSeriesPerMetric`, or a dimension is not valid, the engine returns a no-op object. The engine increments `wardx.internal.cardinality_dropped`.

A dimension value must be a string, a number, or a boolean.

## Use case 2: Record product events and logs

**When:** You need discrete product events or structured logs in the same frame as metrics.

**Objective:** Buffer events and logs until the next snapshot.

```js
core.event('purchase', { product: 'premium' });
core.log.info('match_started', { mode: 'ranked', players: 4 });
core.log.error('payment_failed', { code: 'timeout', stack: 'PaymentError: timeout' });
```

Log levels: `debug`, `info`, `warn`, `error`.

### Buffer limits

- If the event buffer is full, the engine discards the new event.
- If the log buffer is full, the engine replaces a log with a lower severity when possible.
- If the engine cannot replace a log, the engine discards the new log.

Dropped items increment `wardx.internal.events_dropped` or `wardx.internal.logs_dropped`.

Use counters and histograms for rates and latency. Use events for rare product facts: a purchase, an experiment exposure or goal, a named screen. Use logs for failures. Put a clipped `stack` or a provider `code` on the log attrs so MCP `get_recent_logs` can show an agent where to look. The engine does not edit source. Do not put user ids on metric dimensions.

A volume funnel is one event name and one counter per step. The engine does not join events by subject. See `docs/ARCHITECTURE.md`.

## Use case 3: Get Remote Config and assign an experiment

**When:** The server sends a config snapshot. You need a value for a subject.

**Objective:** Get a config value. If an experiment applies, get the variant value.

There is a default subject after `identify(subjectId)`. Pass `{ subjectId }` on a call to override it, or when one process serves many users. Use a stable account id, not `sessionId`. With no subject, `configGet` returns the Remote Config value and that call is not in the A/B test.

```js
core.applyConfig(13, {
  values: {
    'message.delayMs': 1000,
    'chat.enabled': true
  },
  experiments: [
    {
      id: 'message-delay-v1',
      enabled: true,
      allocation: 1,
      salt: '3ad8f9',
      primaryMetric: 'message.sent',
      goalMetric: 'message.sent',
      variants: [
        { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
        { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
      ]
    }
  ]
});

const fallback = 1000;
const shared = core.configGet('message.delayMs', fallback);
core.identify('user-1');
const delay = core.configGet('message.delayMs', fallback);
core.experimentGoal('message.sent', { value: 1 });
const other = core.configGet('message.delayMs', fallback, { subjectId: 'user-2' });
```

`shared` is always the snapshot value (`1000`). `delay` is `1000` or `400` for `user-1`. `other` is the variant for `user-2`. The same `subjectId`, experiment `id`, and `salt` always map to the same variant. You do not persist the group. Changing `salt` redistributes the population. `identify(null)` clears the default.

### Resolution order

1. If the key is not in the snapshot, return `fallback`.
2. If there is no subject (`identify` unset and no `{ subjectId }`), return the Remote Config value.
3. If no enabled experiment contains the key, return the Remote Config value.
4. If the subject is not in the allocation, return the Remote Config value.
5. If the subject is in the allocation, return the variant value.

The first resolve for a subject in a session emits event `experiment.exposure`. The payload contains a hashed subject. The payload does not contain the raw `subjectId`.

`experimentGoal` emits event `experiment.goal`. The subject comes from `identify()` or from `{ subjectId }` on that call. You can supply `value`. Use milliseconds for a session-duration goal. The server stores that number as `goalSum` and `goalMean` per variant. Without a subject, the call throws. One experiment should have one quantitative goal name.

## Use case 4: Assign a variant without WardxCore

**When:** You verify experiment math, or you assign a variant in a test.

**Objective:** Use the same FNV-1a 32-bit function as the SDK.

```js
import { assignVariant, assignmentHash, hashToUnitInterval, subjectHash } from '@wardx/core';

const experiment = {
  id: 'message-delay-v1',
  enabled: true,
  allocation: 0.5,
  salt: '3ad8f9',
  variants: [
    { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
    { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
  ]
};

const variant = assignVariant(experiment, 'user-1');
const hash = assignmentHash(experiment.id, 'user-1', experiment.salt);
const bucket = hashToUnitInterval(hash);
const hashedSubject = subjectHash('demo-subject-hash-v1', 'user-1');
```

Hash input:

```text
hash = fnv1a32(experimentId + ':' + subjectId + ':' + salt)
bucket = hash / 2^32
```

If `bucket >= allocation`, `assignVariant` returns `null`.

`subjectHash` returns 64 lowercase hex digits of `SHA-256(UTF8(privacySalt) || 0x00 || UTF8(subjectId))`.

## Use case 5: Build a frame for a custom transport

**When:** You send frames with your transport. You do not use the Node SDK.

**Objective:** Snapshot dirty data, then take the pending frames.

```js
import { FrameBuilder, PROTOCOL_VERSION, SDK_NAME, PLATFORM } from '@wardx/core';

core.counter('match.completed').inc();
const batch = core.snapshotIfDirty();
if (batch) {
  const frames = core.takePendingFrames();
  const envelope = {
    protocol: PROTOCOL_VERSION,
    project: settings.project,
    sdk: { name: SDK_NAME, version: '0.1.0' },
    client: {
      instanceId: '01…',
      sessionId: '01…',
      role: settings.role,
      appVersion: settings.appVersion,
      environment: settings.environment,
      platform: PLATFORM
    },
    configVersion: core.configStore.version,
    frames
  };
}
```

`snapshotIfDirty` returns `null` when there is no new data.

`snapshotFrame` uses `FrameBuilder.splitToMaxBytes`. It measures the serialized UTF-8 JSON, preserves row order within counters, gauges, histograms, events, and logs, and emits as many physical frames as needed with consecutive `seq` values. Every emitted frame is at most `maxFrameBytes`.

An individual row that cannot fit in an otherwise empty frame is dropped. The batch reports dropped counts by collection and emits their total as `wardx.internal.frame_rows_dropped`. If even that internal row cannot fit, splitting throws. `maxFrameBytes` must be at least `1024`.

Internal series use the prefix `wardx.internal.`.

## Exports

| Export | Function |
| --- | --- |
| `WardxCore` | Engine. |
| `ConfigStore` | Stores one Remote Config snapshot. |
| `ExperimentResolver` | Assigns variants and records exposure. |
| `assignVariant` | Assigns one variant. |
| `fnv1a32`, `assignmentHash`, `hashToUnitInterval`, `subjectHash` | Hash helpers. |
| `Counter`, `Gauge`, `Histogram`, `MetricsRegistry` | Metric types. |
| `EventBuffer`, `LogBuffer` | In-memory buffers. |
| `FrameBuilder` | Builds and splits frames to the serialized byte limit. |
| `resolveSettings`, `loadSdkDefaults`, `nextSyncDelayMs` | Settings helpers. |
| `PROTOCOL_VERSION`, `SDK_NAME`, `PLATFORM`, `INTERNAL` | Protocol constants. |
| `ulid` | Identifier helper. |

## Related packages

- Node.js SDK: `wardx`
- Ingest server: `@wardx/server`

The wire contract is protocol version 1. A runtime sends `POST /v1/sync` with JSON and gzip. The request header is `X-Wardx-Key`.
