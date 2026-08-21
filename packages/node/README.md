# wardx

`wardx` is the Node.js SDK for Wardx.

The SDK records logs, events, and metrics. The SDK also gets Remote Config and assigns experiment variants.

A measure call changes local memory only. The SDK sends frames on a timer. The SDK uses HTTP `POST /v1/sync` with JSON and gzip.

## Install

```bash
npm install wardx
```

```js
import { createWardx } from 'wardx';
```

To receive frames, run an ingest server. Install `@wardx/server` and start it with a config file.

## Design rules

- A measure call does not send network data.
- A measure call does not wait for a Promise.
- Delivery is at-most-once. If a sync fails, the SDK discards the batch.
- The application has priority over telemetry.
- Remote Config is always read from local memory.
- The SDK sends names only. Descriptions live in the server catalog: ship them in the config file, or fill them during MCP onboarding.

**WARNING:** The SDK does not write a disk queue. The SDK does not retry the same frames.

## Start the SDK

`createWardx` requires these keys:

| Key | Description |
| --- | --- |
| `endpoint` | Base URL of the ingest server, for example `http://127.0.0.1:8787`. |
| `projectKey` | Value of header `X-Wardx-Key`. |
| `project` | Project name. The name must match the server mapping. |
| `role` | Name of this instance inside the project, for example `client`, `unity`, `game-server`, `desktop`. Not `*`. |
| `appVersion` | Application version. |
| `environment` | Environment name. |

Optional keys include `privacySalt`, `tracer`, and the keys in `@wardx/core` `defaults.json`. If `privacySalt` is empty, the SDK uses `projectKey`. `tracer` is a local diagnostic hook. It does not go over the wire.

The SDK starts a bootstrap sync immediately. The SDK then syncs on `syncIntervalMs` with jitter.

## Use case 1: Instrument a Node.js service

**When:** You run a Node.js process and you need telemetry.

**Objective:** Record logs, events, and metrics. Then send one batch.

```js
import { createWardx } from 'wardx';

const wardx = createWardx({
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'client',
  appVersion: '2.4.1',
  environment: 'production'
});

wardx.log.info('match_started', { mode: 'ranked', players: 4 });
wardx.event('match.started', { mode: 'ranked', country: 'AR' });
wardx.counter('match.completed', { mode: 'ranked' }).inc();
wardx.gauge('players.online').set(12);
wardx.histogram('request.duration', { buckets: [10, 25, 50, 100, 250] }).observe(42);

const end = wardx.timer('matchmaking.duration');
end({ result: 'success' });

await wardx.flush();
await wardx.shutdown();
```

### Procedure

1. Call `createWardx` with the required keys.
2. Record logs, events, and metrics on the request path or the game loop.
3. Call `flush` when you need to send now.
4. Call `shutdown` when the process stops.

Pass the ingest URL, project key, and project name in `createWardx`.

## Use case 2: Count occurrences with a counter

**When:** You count how many times a thing happens, or you add a quantity.

**Objective:** Use `inc()` for one occurrence. Use `add(n)` for a finite sum.

```js
function handleRequest(req, res, wardx) {
  const requests = wardx.counter('http.requests', { route: 'matchmaking' });
  requests.inc();

  if (res.statusCode >= 500) {
    wardx.counter('http.errors', { route: 'matchmaking', code: 500 }).inc();
  }
}

function grantCoins(wardx, amount) {
  wardx.counter('coins.awarded', { source: 'match' }).add(amount);
}

function completeMatch(wardx, mode) {
  wardx.counter('match.completed', { mode }).inc();
}
```

To detect abnormal grants, pair this counter with a histogram and a rare anomaly event. See use case 8.

### Procedure

1. Call `counter(name, dims)` to get a series.
2. Keep that object if you increment in a loop.
3. Call `inc()` to add `1`.
4. Call `add(n)` to add a finite number.

Each dimension set is a separate series. Use a small set of values, for example `mode`, `route`, or `code`. Do not put a user id in a dimension. If the series count is above `maxSeriesPerMetric`, the SDK returns a no-op counter.

A counter in a frame is a window delta. The counter is not a lifetime total.

## Use case 3: Record a current value with a gauge

**When:** You need the last known size of a set, for example players online or queue depth.

**Objective:** Call `set(value)` with a finite number. The frame stores the last value and a timestamp.

```js
function reportLobby(wardx, lobby) {
  wardx.gauge('players.online', { region: lobby.region }).set(lobby.playerCount);
  wardx.gauge('matchmaking.queue_depth').set(lobby.queue.length);
}

function startQueueProbe(wardx, getQueueDepth) {
  const queue = wardx.gauge('jobs.queue_depth');
  const timer = setInterval(() => {
    queue.set(getQueueDepth());
  }, 1000);
  timer.unref();
  return timer;
}
```

### Procedure

1. Call `gauge(name, dims)` to get a series.
2. Call `set(value)` when the value changes, or on a probe interval.
3. Do not call `inc()` on a gauge. A gauge does not add. A gauge replaces.

If you do not call `set` in a window, that series is not in the frame.

## Use case 4: Record a distribution with a histogram

**When:** You already have a numeric sample, for example a duration in milliseconds or a payload size.

**Objective:** Call `observe(value)` so the SDK stores count, sum, min, max, and buckets.

```js
function recordRequest(wardx, durationMs, bytes) {
  wardx.histogram('http.duration_ms', { route: 'checkout' }).observe(durationMs);
  wardx.histogram('http.payload_bytes', {
    buckets: [256, 1024, 4096, 16384, 65536]
  }).observe(bytes);
}

function recordAward(wardx, amount, grantId) {
  wardx.histogram('coins.award_size').observe(amount, { grantId });
}
```

The default buckets come from SDK defaults: `[10, 25, 50, 100, 250, 500, 1000]`. Set `buckets` when the unit is not a short duration in milliseconds.

Do not change the buckets of an existing series. The SDK throws an error.

A sample above the last bound stays in `count`, `sum`, `min`, and `max`. That sample does not increment a bucket.

`observe(value, attrs)` keeps `attrs` only for the window max. The histogram body then includes `exemplar`. Attrs use the same limits as dimensions. Pass a lookup key (`grantId`, `matchId`), not a user id as a metric dimension.

If you start and stop a duration in the same process, use `timer` instead of a histogram. See use case 5.

## Use case 5: Measure elapsed time with a timer

**When:** You need the time of an HTTP handler, a matchmaking call, or a database query.

**Objective:** Start a timer. Stop the timer when the work ends. The SDK records milliseconds in a histogram.

```js
export async function handleMatchmaking(req, res, wardx) {
  const end = wardx.timer('matchmaking.duration', { route: 'matchmaking' });
  try {
    const result = await findMatch(req.body);
    wardx.counter('matchmaking.ok').inc();
    end({ result: 'success' });
    res.end(JSON.stringify(result));
  } catch (err) {
    wardx.counter('matchmaking.error').inc();
    wardx.log.error('matchmaking_failed', { code: err.code || 'unknown' });
    end({ result: 'error' });
    res.statusCode = 500;
    res.end();
  }
}

function parseReplay(buffer, wardx) {
  const end = wardx.timer('replay.parse');
  const replay = decodeReplay(buffer);
  end();
  return replay;
}
```

The stop function records milliseconds. Dimensions that you pass to the stop function merge with the start dimensions. Call the stop function one time.

## Use case 6: Record a product event

**When:** You need a discrete product fact with attributes, for example a purchase or a match start.

**Objective:** Call `event(name, attrs)`. Do not use an event when a counter is enough.

```js
function onMatchStarted(wardx, match) {
  wardx.event('match.started', {
    mode: match.mode,
    country: match.country,
    players: match.players.length
  });
  wardx.counter('match.started', { mode: match.mode }).inc();
}

function onPurchase(wardx, order) {
  wardx.event('purchase', {
    product: order.product,
    currency: order.currency,
    amount: order.amount
  });
  wardx.counter('purchase.count', { product: order.product }).inc();
  wardx.counter('purchase.amount', { currency: order.currency }).add(order.amount);
}

function onSignup(wardx, user) {
  wardx.event('signup.completed', { method: user.method });
}
```

### Procedure

1. Call `event(name, attrs)` on the product path.
2. Put facts that you need on each occurrence in `attrs`.
3. Add a counter when you also need an aggregatable count.

An event is one row in the frame. A counter is a window sum. Use both when you need the fact and the rate.

If the event buffer is full, the SDK discards the new event and increments `wardx.internal.events_dropped`.

## Use case 7: Measure a volume funnel

**When:** You need drop-off between screens or steps in a client, for example onboarding or checkout.

**Objective:** Emit one named event and one counter per step. Compare those counts. Do not reconstruct a per-user path.

Wardx does not store a user journey. Delivery is at-most-once. Production discards envelopes after ingest (`sink: "null"`). The aggregator counts events by name and role. Event attrs do not split that count. `sessionId` identifies the envelope. It is not a join key. There are no unique users, no ordered sequences, and no time between steps.

Give each step its own name. Do not reuse `screen.view` with a `surface` attr as the funnel. Use `surface` only as a counter dimension when you also need a breakdown of one step.

```js
function onOnboardingStart(wardx, channel) {
  wardx.event('onboarding.start', { channel });
  wardx.counter('onboarding.start', { channel }).inc();
}

function onOnboardingProfile(wardx) {
  wardx.event('onboarding.profile');
  wardx.counter('onboarding.profile').inc();
}

function onOnboardingDone(wardx, userId) {
  wardx.event('onboarding.done');
  wardx.counter('onboarding.done').inc();
  wardx.experiment.goal('onboarding.done', { subjectId: userId });
}
```

### Procedure

1. Pick a prefix and a name per step: `onboarding.start`, `onboarding.profile`, `onboarding.done`.
2. On the client path for that step, call `event` and `counter` with the same name.
3. Put only low-cardinality attrs on the event. Put the breakdown you need to compare (`channel`, `mode`) on the counter dimensions.
4. If the last step is an experiment conversion, also call `experiment.goal` with `subjectId`. That is one conversion, not an N-step funnel.
5. From MCP, call `get_aggregates` with those names. Compare counter totals, or `eventNames` counts, in the same window. The drop from start to done is the volume funnel.

On a backend that serves many users, increment the counters in process. Do not `event()` once per user action.

Do not put `userId` on a counter dimension. Do not expect Mixpanel-style unique-user funnels from Wardx.

## Use case 8: Detect abnormal point accumulation

**When:** A game grants points, coins, or XP. You need to see whether the economy is consistent, or whether grants jumped outside the normal range.

**Objective:** Measure the grant stream as rates and a size distribution. Do not measure per player.

Wardx is not a ledger. Delivery is at-most-once. Production discards envelopes after ingest (`sink: "null"`). A player's wallet, and the row that explains one grant, live in the game database. Wardx answers whether the fleet is granting too much, or too large, in a 1-minute window.

```js
function grantCoins(wardx, grant) {
  const { source, amount, reason, id } = grant;

  wardx.counter('coins.awarded', { source }).add(amount);
  wardx.counter('coins.grants', { source }).inc();
  wardx.histogram('coins.award_size', {
    source,
    buckets: [10, 50, 100, 250, 500, 1000, 5000]
  }).observe(amount, { grantId: id, reason });

  const maxAward = wardx.config.get('economy.maxAward', 500);
  if (amount > maxAward) {
    wardx.event('coins.anomaly', { source, amount, reason, grantId: id });
    wardx.log.warn('coins_anomaly', { source, amount, reason, grantId: id });
  }
}
```

`source` is a small set, for example `match`, `daily`, `purchase`, or `admin`.

### Procedure

1. Write the wallet change in the game database in the same transaction as the grant. That row is the audit of the player.
2. On the grant path, add the amount to `coins.awarded` and increment `coins.grants`. The dimension is `source`, not a user id.
3. Observe the amount in `coins.award_size` with a lookup key (`grantId`). The histogram keeps those attrs only for the window max, as `exemplar`. Histogram `max` and the upper buckets are the inconsistency signal. The exemplar is the row to open in the database.
4. Read `economy.maxAward` from Remote Config. Emit `coins.anomaly` only when a grant exceeds that bound. That event is rare.
5. From MCP, compare `coins.awarded / coins.grants` (mean grant) and `coins.award_size` max against `economy.maxAward`. If max is high, read `exemplar.attrs.grantId`.

Do not put `userId` on a counter or histogram dimension. The SDK and the server cap series. A unique id per player creates a series per player and then drops. An exemplar is one sample per series per window, so a lookup key there does not explode cardinality. Do not `event()` once per grant on a backend that serves many users. Use an event only for the anomaly.

If histogram max stays at the legal cap and `coins.awarded` tracks completed matches times the known reward, the economy is consistent at fleet scale. A specific player still requires the database audit log.

## Use case 9: Get Remote Config for a user

**When:** The server has a config snapshot. You need a value in the application.

**Objective:** Read the local snapshot. Do not wait for the network on the hot path.

```js
const timeoutMs = wardx.config.get('matchmaking.timeoutMs', 5000);
const chatEnabled = wardx.config.get('chat.enabled', false);
const delayMs = wardx.config.get('message.delayMs', 1000, { subjectId: req.userId });
```

### Resolution order

1. If the key is not in the snapshot, return the fallback.
2. If `subjectId` is missing, return the Remote Config value.
3. If an experiment applies to the subject, return the variant value.

The SDK updates the snapshot when a sync response contains a newer `configVersion`. Until that sync, `config.get` returns the fallback or the last snapshot.

## Use case 10: Run an A/B experiment and record a goal

**When:** A Remote Config key is in an experiment. You need a variant for a user. You need a goal event.

**Objective:** Get the variant value. Then record `experiment.goal`.

The ingest server config can define experiment `message-delay-v1` on key `message.delayMs`. See `@wardx/server`.

```js
function sendMessage(wardx, userId, text) {
  const delayMs = wardx.config.get('message.delayMs', 1000, { subjectId: userId });

  setTimeout(() => {
    deliver(text);
    wardx.counter('message.sent').inc();
    wardx.experiment.goal('message.sent', { subjectId: userId, value: 1 });
  }, delayMs);
}
```

The first `config.get` with a `subjectId` in a session can emit event `experiment.exposure`. The payload contains:

- `experiment`
- `variant`
- `subject` (hashed)

The payload does not contain the raw `subjectId`.

`experiment.goal` requires `subjectId`. The event includes the known assignments for that subject.

The assignment is local and deterministic. The same subject, experiment, and salt always get the same variant.

## Use case 11: Continue when the ingest server is down

**When:** The network fails, or the ingest server is not available.

**Objective:** Keep the application. Discard failed batches.

```js
const wardx = createWardx({
  endpoint: 'http://127.0.0.1:1',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'client',
  appVersion: '0.1.0',
  environment: 'development'
});

wardx.counter('jobs.completed').inc();
await wardx.shutdown();
```

The SDK still records in memory. A failed sync increments `wardx.internal.frames_failed`. The next cycle sends new data only.

Do not use this SDK if you must not lose events. This SDK is best-effort.

## Use case 12: Stop the SDK in a graceful shutdown

**When:** The process receives `SIGTERM` or you stop a test.

**Objective:** Send the last frame, then release the HTTP agent.

```js
const wardx = createWardx({
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'client',
  appVersion: '0.1.0',
  environment: 'production'
});

async function onStop() {
  await wardx.shutdown();
  process.exit(0);
}

process.on('SIGTERM', onStop);
process.on('SIGINT', onStop);
```

`shutdown` is safe to call more than one time. The second call returns immediately.

`flush` sends the current pending frames and does not stop the timers. Use `shutdown` when the process stops.

## Use case 13: Trace measure calls while instrumenting

**When:** You are adding counters, events, and logs and you want to see each call and each sync on stderr.

**Objective:** Pass a tracer object. The SDK does not print on its own.

```js
import { createWardx, createConsoleTracer } from 'wardx';

const wardx = createWardx({
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'client',
  appVersion: '0.1.0',
  environment: 'development',
  tracer: createConsoleTracer()
});
```

A tracer is a duck-typed object. Implement any of `measure`, `event`, `log`, `frame`, and `sync`. Omit the rest. `createConsoleTracer()` writes one line per hook to stderr.

The tracer runs on the measure path. Use it in development. Remove `tracer` before production. It does not change frames, delivery, or Remote Config.

## API

| Call | Description |
| --- | --- |
| `createWardx(options)` | Creates the SDK. Starts aggregate and sync timers. Optional `tracer`. |
| `createConsoleTracer(options)` | Local stderr tracer. Optional `options.stream`. |
| `counter(name, dims)` | Returns a counter. `inc()` or `add(n)`. |
| `gauge(name, dims)` | Returns a gauge. `set(value)`. |
| `histogram(name, dimsOrBuckets)` | Returns a histogram. `observe(value)` or `observe(value, attrs)`. |
| `timer(name, dims)` | Starts a timer. The returned function records milliseconds. |
| `event(name, attrs)` | Buffers a product event. |
| `log.debug\|info\|warn\|error(message, attrs)` | Buffers a structured log. |
| `config.get(key, fallback, context)` | Reads Remote Config. `context.subjectId` enables experiments. |
| `experiment.goal(name, context)` | Emits `experiment.goal`. `context.subjectId` is required. |
| `flush()` | Sends pending frames now. Returns a Promise. |
| `shutdown()` | Stops timers, sends pending frames, and closes the HTTP agent. |

The SDK creates one `instanceId` and one `sessionId` per process. The IDs are ULIDs.

Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`. The default interval is 15 seconds. The default jitter is 0.85 to 1.15.

## Related packages

- Engine: `@wardx/core`
- Ingest server: `@wardx/server`
