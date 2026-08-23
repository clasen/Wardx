# wardx

`wardx` is the Node.js SDK for Wardx.

This SDK talks to that server. See [Wardx](https://github.com/clasen/Wardx).

The SDK records logs, events, and metrics. The SDK also gets Remote Config and assigns experiment variants.

A measure call changes local memory only. The SDK sends frames on a timer. The SDK uses HTTP `POST /v1/sync` with JSON and gzip.

```text
                         AGENT
                  arisa.sh / Codex / Claude
                             │
                    MCP stdio
                    tools + wardx://project/{name}
                             ▼
┌─────────────────────────────────────────────────────┐
│              wardx-server (one process)             │
│              N isolated projects                    │
│                                                     │
│   MCP ──> ControlService                            │
│              ├── Remote Config snapshot             │
│              ├── Experiment definitions             │
│              ├── Aggregates                         │
│              ├── Recent logs                        │
│              └── Catalog                            │
│                                                     │
│   HTTP POST /v1/sync                                │
│        ├── envelope store (config.sink)             │
│        │     null | memory | ndjson                 │
│        └── per-project ingest                       │
│              aggregator, recent logs, clients       │
│              config reply filtered by client.role   │
└─────────────────────────────────────────────────────┘
                             ▲
                             │
             frames up / that role's config down
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
   Node SDK                          C# / Unity SDK
   wardx / @wardx/core               clients/csharp
   role: game-server                 role: mobile
   metrics / config.get              same /v1/sync
```

## Install

```bash
npm install wardx
```

```js
import { createWardx } from 'wardx';
```

To receive frames, run an ingest server. Install `@wardx/server` and start it with a config file.

> [!NOTE]
> **Agent skill.** Teach the agent this Node SDK with the [Skills CLI](https://skills.sh):
>
> ```bash
> npx skills add https://github.com/clasen/Wardx --skill wardx
> ```

## Design rules

- A measure call does not send network data.
- A measure call does not wait for a Promise.
- Delivery is at-most-once. If a sync fails, the SDK discards the batch.
- The application has priority over telemetry.
- Remote Config is always read from local memory.
- The SDK sends names only. Descriptions live in the server catalog: ship them in the config file, or fill them during MCP onboarding.
- `identify(subjectId)` sets the default subject for this instance. A per-call `{ subjectId }` overrides it. A process that serves many users must pass `subjectId` on each call and must not `identify()`.

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
5. From MCP, the overview ranks histogram outcomes by `max` and includes the exemplar. Compare that max and `coins.awarded / coins.grants` (mean grant) against `economy.maxAward`. If max is high, read `exemplar.attrs.grantId`, then `get_recent_logs` with `coins_anomaly` or that `grantId`. If the role has `path` or `git`, search that checkout for `source` / `reason`. See `@wardx/server` use case 9.

Do not put `userId` on a counter or histogram dimension. The SDK and the server cap series. A unique id per player creates a series per player and then drops. An exemplar is one sample per series per window, so a lookup key there does not explode cardinality. Do not `event()` once per grant on a backend that serves many users. Use an event only for the anomaly.

If histogram max stays at the legal cap and `coins.awarded` tracks completed matches times the known reward, the economy is consistent at fleet scale. A specific player still requires the database audit log.

## Use case 9: Get Remote Config for a user

**When:** The server has a config snapshot. You need a value in the application.

**Objective:** Read the local snapshot. Do not wait for the network on the hot path.

A call with no subject returns the shared Remote Config value for that role. To vary per person, set a subject with `identify()`, or pass `{ subjectId }` on that call. Use a stable account id (`user.id`, `playerId`). Do not use `sessionId`. The SDK already creates a `sessionId` for the envelope. That id is not a join key and must not be the experiment subject.

```js
const timeoutMs = wardx.config.get('matchmaking.timeoutMs', 5000);
const chatEnabled = wardx.config.get('chat.enabled', false);

// Single-user process (desktop, one logged-in client)
wardx.identify(user.id);
const delayMs = wardx.config.get('message.delayMs', 1000);

// Many users in one process (game-server). Do not identify().
const otherDelayMs = wardx.config.get('message.delayMs', 1000, { subjectId: req.userId });
```

`identify(null)` clears the default. After that, `config.get` without `{ subjectId }` is shared Remote Config again. A per-call `{ subjectId }` overrides `identify()`.

If there is no identified subject and you omit `{ subjectId }`, that call is not in an experiment.

### Resolution order

1. If the key is not in the snapshot, return the fallback.
2. If there is no subject (`identify` unset and no `{ subjectId }`), return the Remote Config value.
3. If an experiment applies to the subject, return the variant value.

The SDK updates the snapshot when a sync response contains a newer `configVersion`. Until that sync, `config.get` returns the fallback or the last snapshot.

## Use case 10: Run an A/B experiment and record a goal

**When:** A Remote Config key is in an experiment. You need a variant for a user. You need a goal event.

**Objective:** Get the variant value. Then record `experiment.goal`.

The ingest server config can define experiment `message-delay-v1` on key `message.delayMs`. See `@wardx/server`. Variants live on the server. The app still reads the same key.

On a client with one user, call `identify` once after login. Later `config.get` and `experiment.goal` use that subject. On a server that handles many users, pass `{ subjectId }` on every call. Do not `identify()` there: it is process-wide and would mix users.

```js
wardx.identify(userId);
const delayMs = wardx.config.get('message.delayMs', 1000);
setTimeout(() => {
  deliver(text);
  wardx.counter('message.sent').inc();
  wardx.experiment.goal('message.sent', { value: 1 });
}, delayMs);

function sendMessage(wardx, userId, text) {
  const delayMs = wardx.config.get('message.delayMs', 1000, { subjectId: userId });
  setTimeout(() => {
    deliver(text);
    wardx.counter('message.sent').inc();
    wardx.experiment.goal('message.sent', { subjectId: userId, value: 1 });
  }, delayMs);
}
```

The assignment is local and deterministic. The same `subjectId`, experiment `id`, and `salt` always map to the same variant. You do not persist the group. You do not ask the server which group the user is in. Changing the experiment `salt` redistributes the population. Keep the salt when you replace the same experiment `id`.

The first `config.get` that has a subject in a session can emit event `experiment.exposure`. The payload contains:

- `experiment`
- `variant`
- `subject` (hashed)

The payload does not contain the raw `subjectId`.

`experiment.goal` needs a subject: from `identify()` or from `{ subjectId }` on that call. The event includes the known assignments for that subject. Without a subject, the call throws.

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

## Use case 14: Measure play-session duration

**When:** You want to maximize how long people play, or how much time the fleet spent in a window.

**Objective:** Record a play-session clock in the application. Do not use the SDK `sessionId`.

A play session is an interval you own: app open to close, login to logout, or match start to leave. The SDK `sessionId` identifies the envelope. It is not that clock. Wardx does not join events by subject, so it cannot compute duration after the fact.

Two signals:

1. **Ended session (distribution + A/B).** When the session ends, observe the elapsed milliseconds. Emit one `experiment.goal` with that value so `analyze_experiment` can split by variant.
2. **Fleet play time (accumulated).** Add the same milliseconds to `session.time_ms`. `get_aggregates` then shows how much time the fleet played in that minute. Optional: add a heartbeat while the session is open so a crash still counts the minutes already played.

```js
const SESSION_BUCKETS = [30_000, 60_000, 180_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000];

function onPlaySessionStart(wardx, userId) {
  wardx.identify(userId);
  return { startedAt: Date.now() };
}

function onPlaySessionEnd(wardx, session) {
  const durationMs = Date.now() - session.startedAt;
  wardx.histogram('session.duration', { buckets: SESSION_BUCKETS }).observe(durationMs);
  wardx.counter('session.time_ms').add(durationMs);
  wardx.counter('session.ended').inc();
  wardx.experiment.goal('session.duration', { value: durationMs });
}

function onPlayHeartbeat(wardx, elapsedMs) {
  wardx.counter('session.time_ms').add(elapsedMs);
}
```

On a process that serves many users, skip `identify()` and pass `{ subjectId }` on `experiment.goal`.

### Procedure

1. Start a local clock when the play session starts. Do not use `sessionId`.
2. When it ends, observe `session.duration` with minute-scale buckets. Default histogram buckets are for short durations in milliseconds.
3. Add the same number to `session.time_ms`. Increment `session.ended`.
4. Call `experiment.goal('session.duration', { value: durationMs })` with a subject. Emit that goal once per ended session. `analyze_experiment` then has `goalSum`, `goalMean`, and a `decision` per variant. Mean session ms is `goalSum / goals`.
5. From MCP, read `session.time_ms` in `get_aggregates` for fleet minutes. Compare variants with `analyze_experiment`, not with a counter dimension. Ship a winner with `ship_experiment`.

Do not put `userId` on the histogram. Do not emit `experiment.goal` on every heartbeat: that would count many goals for one session. The heartbeat only adds to `session.time_ms`.

If you only increment `session.time_ms` and never emit the goal, MCP can still see fleet play time. It cannot compare variants. One experiment should have one quantitative `experiment.goal` name. Mixing a duration value with a `value: 1` conversion on the same experiment corrupts `goalMean`.

## Use case 15: A/B test level difficulty to increase session time

**When:** You suspect a level is too hard or too easy, and you want longer sessions.

**Objective:** Put the difficulty knobs in Remote Config. Measure starts, fails, and completes. Experiment on those knobs. Use session duration from use case 14 as the goal.

The keys must already exist in Remote Config. The game reads them with `config.get`. Variants may only change those keys.

```js
function onLevelStart(wardx, userId, levelId) {
  const enemyHp = wardx.config.get(`level.${levelId}.enemyHp`, 100, { subjectId: userId });
  wardx.event('level.start', { level: levelId });
  wardx.counter('level.start', { level: levelId }).inc();
  return enemyHp;
}

function onLevelFail(wardx, levelId) {
  wardx.event('level.fail', { level: levelId });
  wardx.counter('level.fail', { level: levelId }).inc();
}

function onLevelComplete(wardx, levelId) {
  wardx.event('level.complete', { level: levelId });
  wardx.counter('level.complete', { level: levelId }).inc();
}
```

`level` is a small set of ids. Do not put a unique run id on the counter.

The volume funnel `level.start` → `level.fail` / `level.complete` is the difficulty signal. A high fail-to-start ratio means the level is hard. That comparison is counts in one window, not unique players. Keep `level.complete` as a counter. Do not also emit `experiment.goal` for it if the experiment goal is `session.duration`.

Call `experiment.goal('session.duration', { value: durationMs })` when the play session ends (use case 14).

From MCP, after onboarding: `upsert_experiment` on the existing keys (`level.3.enemyHp`, …) with a hypothesis such as "Lower HP on level 3 increases session duration", `primaryMetric: 'session.time_ms'`, `goalKind: 'mean'`, `control`, `minExposures`, `confidence`, and variants that only change those keys. Later `analyze_experiment`: follow `decision` and compare `goalMean` for the duration goal. `ship_experiment` when status is `winner`. Compare the funnel counts with `get_aggregates`. See `@wardx/server` use case 7.

## Use case 16: Surface an error so an agent can open the source

**When:** A server or client fails and you want an agent to see enough to patch the file.

**Objective:** Count the failure. Log the error with a stack or a provider code. Wardx does not edit source. MCP returns the row. The agent uses `path` or `git` on that role, plus its own file permissions, to change the code.

```js
function handleCheckout(req, res, wardx) {
  try {
    charge(req.body);
    wardx.counter('payment.ok').inc();
  } catch (err) {
    wardx.counter('payment.error', { code: err.code || 'unknown' }).inc();
    wardx.log.error('payment_failed', {
      name: err.name,
      code: err.code || 'unknown',
      stack: clipStack(err)
    });
    res.statusCode = 500;
    res.end();
  }
}

function clipStack(err, max = 4096) {
  const stack = err instanceof Error ? err.stack : String(err);
  if (!stack) return null;
  return stack.length <= max ? stack : stack.slice(0, max);
}
```

`stack` is an attr string. Do not send the Error object.

From MCP: `get_aggregates` for the rate, then `get_recent_logs` with `level: 'error'` and the message. If the role has `path` or `git` in the catalog, the agent opens that checkout and edits there. If those fields are empty, Wardx has no source hint. Do not invent a path.

The log ring is recent only (`recentLogsMax`). It is not a history search. See `@wardx/server` use case 8.

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
| `identify(subjectId)` | Sets the default subject for this instance. `identify(null)` clears it. Process-wide: do not use on a game-server that serves many users. |
| `config.get(key, fallback, context)` | Reads Remote Config. Uses `identify()` or `{ subjectId }`. A per-call `{ subjectId }` overrides `identify()`. Omit both for the shared value. |
| `experiment.goal(name, context)` | Emits `experiment.goal`. Needs a subject from `identify()` or `{ subjectId }`. Optional `value` for a quantitative goal such as session duration. |
| `flush()` | Sends pending frames now. Returns a Promise. |
| `shutdown()` | Stops timers, sends pending frames, and closes the HTTP agent. |

The SDK creates one `instanceId` and one `sessionId` per process. The IDs are ULIDs.

Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`. The default interval is 15 seconds. The default jitter is 0.85 to 1.15.

## Related packages

- Engine: `@wardx/core`
- Ingest server: `@wardx/server`
