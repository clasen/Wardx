---
name: wardx
description: Instruments Node.js with the Wardx SDK (wardx / createWardx) — counters, gauges, histograms, timers, events, logs, Remote Config, experiment assignment, and volume funnels. Use when the user mentions wardx, createWardx, config.get, experiment.goal, createConsoleTracer, packages/node, packages/core, @wardx/core, funnel, onboarding steps, or asks to add telemetry, metrics, events, logs, or A/B assignment in application code. Also use when changing the Node SDK or the core engine. Do not use for MCP tools, catalog onboarding, ingest control, or POST /v1/sync from an agent — that belongs to wardx-server.
---

# Wardx Node SDK

`wardx` is the Node.js runtime. `@wardx/core` is the in-process engine. Assignment and `config.get` run here. HTTP `POST /v1/sync` lives here. MCP does not.

- A measure call changes local memory only. It does not send. It does not return a Promise.
- Delivery is at-most-once. A failed sync discards that batch. There is no disk queue and no retry of the same frames.
- Remote Config is always a local read of the last snapshot.
- The SDK sends names. Descriptions live in the server catalog.

Control plane (MCP, catalog, experiments as definitions, aggregates) is the **wardx-server** skill. This skill writes application instrumentation and SDK code. C# / Unity instrumentation is `clients/csharp`, not this package.

Package internals when editing `packages/node` or `packages/core`: [references/package.md](references/package.md).

## First actions

1. Import from `wardx`. Use `@wardx/core` only when writing a custom runtime (no HTTP).
2. Call `createWardx` with every required key. Do not invent fallbacks for missing keys.
3. Pick the cheapest signal that answers the question (table below).
4. Call `shutdown` when the process stops. `flush` sends now and leaves timers running.

Required `createWardx` keys: `endpoint`, `projectKey`, `project`, `role`, `appVersion`, `environment`. `role` is an open name (`client`, `unity`, `game-server`, `desktop`). It cannot be `*`. `project` must match the server mapping. `projectKey` is header `X-Wardx-Key`.

Optional: `privacySalt` (empty → `projectKey`), `tracer`, and keys in `packages/core/defaults.json`. A bootstrap sync starts immediately; later syncs use `syncIntervalMs` with jitter.

## Choose a signal

Use the cheapest signal that still answers the question.

| Need | Call |
| --- | --- |
| How many / how much in this window | `counter(name, dims).inc()` or `.add(n)` |
| Last known size of a set | `gauge(name, dims).set(value)` |
| Distribution of a sample you already have | `histogram(name, …).observe(value)` |
| Elapsed time you start and stop here | `timer(name, dims)` then the stop function |
| One discrete product fact | `event(name, attrs)` plus a counter when you also need a rate |
| Drop-off between named steps (volume funnel) | one `event` + one `counter` per step name. Not a unique-user path. |
| Play-session length / fleet play time | App clock on start; on end `histogram('session.duration')` + `counter('session.time_ms').add(ms)` + `experiment.goal('session.duration', { value: ms })`. Optional heartbeat adds only to `session.time_ms`. Not the SDK `sessionId`. |
| Level difficulty (too hard / too easy) | Remote Config knobs + volume funnel `level.start` → `level.fail` / `level.complete`. Session duration is the A/B goal. |
| Failure on a request path | `log.error(message, attrs)` plus a counter. A stack is an attr. MCP returns the row; the agent edits source via the role `path`/`git`. |
| Rare anomaly or purchase | `event` (not once per grant on a busy backend) |
| Default experiment subject | `identify(subjectId)` on a single-user process. `identify(null)` clears. |
| Remote value / variant | `config.get(key, fallback, context)` |
| Experiment conversion | `experiment.goal(name, { subjectId })` |

A counter in a frame is a window delta, not a lifetime total. A gauge that is never `set` in a window is absent. Keep the series object when you increment in a loop.

**Dimensions.** Small sets: `mode`, `route`, `code`, `source`, `result`. Values are string, number, or boolean. Never `userId`, email, or a unique id on a metric dimension. The SDK caps series per name (`maxSeriesPerMetric`); extra series become no-ops and increment `wardx.internal.cardinality_dropped`. Histogram `observe(value, attrs)` keeps attrs only for the window max (`exemplar`). A lookup key (`grantId`, `matchId`) belongs there, not on the series.

**Backend vs client.** If one process serves many users, increment counters in process. Do not `event()` once per user action. Give that process its own `role` so MCP does not mix it with a player client.

**Funnels.** Wardx compares how often each named step fired. It does not store a user journey. Give each step its own name (`onboarding.start` → `onboarding.profile` → `onboarding.done`, or `level.start` → `level.fail` / `level.complete`). Emit the event and increment a counter of the same name. Put the breakdown (`channel`, `mode`, `level`) on the counter, not as the only discriminator of a shared `screen.view`. Event attrs do not split the server count. `sessionId` is envelope identity, not a join key. `experiment.goal` is one conversion or one quantitative value, not an N-step funnel. One experiment should have one quantitative goal name. Read the drop with `get_aggregates` (wardx-server). Do not invent Mixpanel-style unique-user sequences.

**Session time.** The app owns the play-session clock. Do not use `sessionId`. On end: observe `session.duration` with minute-scale buckets, add the same ms to `session.time_ms`, increment `session.ended`, emit `experiment.goal('session.duration', { value: durationMs })` once. A heartbeat may add to `session.time_ms` only. `analyze_experiment` compares `goalMean` by variant. See the wardx README use cases 14 and 15.

**Economy.** Wardx is not a ledger. Wallet rows live in the application database. On the grant path: `coins.awarded` (`.add(amount)`), `coins.grants` (`.inc()`), `coins.award_size` histogram with exemplar. Emit `coins.anomaly` only when amount exceeds a Remote Config cap.

Do not ship catalog descriptions from the SDK. Name the metric; meaning is onboarded on the server.

## Remote Config and experiments

`identify(subjectId)` sets the default subject for this SDK instance. Later `config.get` and `experiment.goal` use it. A per-call `{ subjectId }` overrides it. `identify(null)` clears it. Use a stable account id (`user.id`, `playerId`), not `sessionId`.

On a single-user process (desktop, one logged-in client), `identify` once after login. On a process that serves many users (`game-server`), pass `{ subjectId }` on every call. Do not `identify()` there: it is process-wide and would mix users.

```js
wardx.identify(userId);
const timeoutMs = wardx.config.get('matchmaking.timeoutMs', 5000);
const delayMs = wardx.config.get('message.delayMs', 1000);
wardx.experiment.goal('message.sent', { value: 1 });

const otherDelayMs = wardx.config.get('message.delayMs', 1000, { subjectId: otherUserId });
```

Resolution:

1. Key missing from the snapshot → fallback.
2. No subject (`identify` unset and no `{ subjectId }`) → Remote Config value. That call is not in the A/B test.
3. Experiment applies to the subject → variant value.

Until a sync applies a newer `configVersion`, `config.get` returns the fallback or the last snapshot. The first `config.get` with a subject in a session can emit `experiment.exposure` (`experiment`, `variant`, hashed `subject`). The raw `subjectId` never goes on the wire. Assignment is local and deterministic (same subject, experiment, salt → same variant). Do not persist the variant. Do not ask the server which group the user is in. Changing `salt` redistributes; keep it when replacing the same experiment `id`.

`experiment.goal` needs a subject from `identify()` or `{ subjectId }`. It emits event `experiment.goal` with known assignments for that subject. Optional `value`. Without a subject, the call throws.

Do not wait for the network on the hot path. Do not invent experiment definitions in application code; the server stores them. Do not put `subjectId` on metric dimensions.

## Lifecycle

```js
process.on('SIGTERM', () => wardx.shutdown().then(() => process.exit(0)));
process.on('SIGINT', () => wardx.shutdown().then(() => process.exit(0)));
```

`shutdown` is safe to call more than once. The SDK records in memory if ingest is down; failed syncs increment `wardx.internal.frames_failed`. The next cycle sends new data only. Do not use this SDK when loss is unacceptable.

`tracer` is a local diagnostic hook (`measure`, `event`, `log`, `frame`, `sync`). `createConsoleTracer()` writes stderr. It does not go over the wire. Use it while instrumenting. Omit it in production.

## Changing the SDK

When the task is code in `packages/node` or `packages/core`: keep measure calls synchronous and non-blocking. HTTP, gzip, timers, and process RSS stay in `packages/node`. Engine, settings, frames, and assignment stay in `packages/core`. Do not add retries of the same frames or a disk queue. See [references/package.md](references/package.md).

## Examples

**User says:** "Add Wardx to this Node service."

```js
import { createWardx } from 'wardx';

const wardx = createWardx({
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'game-server',
  appVersion: '2.4.1',
  environment: 'production'
});

function handleMatchmaking(req, res) {
  const end = wardx.timer('matchmaking.duration', { route: 'matchmaking' });
  wardx.counter('http.requests', { route: 'matchmaking' }).inc();
  try {
    const result = findMatch(req.body);
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
```

**User says:** "Instrument the onboarding funnel."

```js
wardx.event('onboarding.start', { channel });
wardx.counter('onboarding.start', { channel }).inc();
wardx.event('onboarding.done');
wardx.counter('onboarding.done').inc();
wardx.experiment.goal('onboarding.done', { subjectId: userId });
```

One name per step. Compare those counts. Do not put `userId` on the counter. Do not promise unique-user sequences.

**User says:** "A/B the message delay for a user." / "How do I identify()?"

```js
wardx.identify(userId);
const delayMs = wardx.config.get('message.delayMs', 1000);
wardx.experiment.goal('message.sent', { value: 1 });
```

On a `game-server`, skip `identify()` and pass `{ subjectId: userId }` on each `config.get` and `experiment.goal`.

1. Identify once on a single-user process, or pass `subjectId` per call on a multi-user process.
2. Do not define variants in the app. Point the user at MCP / wardx-server to `upsert_experiment` on an existing knob.
3. If there is no subject, that read stays on Remote Config and no exposure fires.

**User says:** "Measure session duration." / "A/B difficulty so people play longer."

```js
const SESSION_BUCKETS = [30_000, 60_000, 180_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000];
wardx.identify(userId);
const enemyHp = wardx.config.get('level.3.enemyHp', 100);
const startedAt = Date.now();
// … play session …
const durationMs = Date.now() - startedAt;
wardx.histogram('session.duration', { buckets: SESSION_BUCKETS }).observe(durationMs);
wardx.counter('session.time_ms').add(durationMs);
wardx.counter('session.ended').inc();
wardx.experiment.goal('session.duration', { value: durationMs });
```

Instrument `level.start` / `level.fail` / `level.complete` as a volume funnel. Do not emit `experiment.goal` for those steps if the experiment goal is session duration. Point the user at MCP / wardx-server to `upsert_experiment` on the existing difficulty keys.

**User says:** "Log this error so an agent can fix the file."

```js
wardx.counter('payment.error', { code: err.code || 'unknown' }).inc();
wardx.log.error('payment_failed', { name: err.name, code: err.code || 'unknown', stack: clipStack(err) });
```

`stack` is a clipped string. Wardx does not edit source. Point the user at wardx-server: `get_recent_logs`, then the role `path` / `git`.

**User says:** "Count coin grants without exploding cardinality."

```js
wardx.counter('coins.awarded', { source }).add(amount);
wardx.counter('coins.grants', { source }).inc();
wardx.histogram('coins.award_size', { source, buckets: [10, 50, 100, 250, 500, 1000, 5000] })
  .observe(amount, { grantId: id });
if (amount > wardx.config.get('economy.maxAward', 500)) {
  wardx.event('coins.anomaly', { source, amount, grantId: id });
}
```

## Troubleshooting

**`createWardx missing required keys`.** Pass every required key. The loader does not default them.

**`role cannot be *`.** `*` is a server visibility token, not an instance role.

**No Remote Config / always fallback.** Bootstrap or a later sync has not applied a snapshot yet, or `project` / `projectKey` / `role` do not match the server. The app must still run.

**Silent no-op metrics.** Series cap or invalid dimensions. Check `wardx.internal.cardinality_dropped`. Remove unique ids from dims.

**`histogram … buckets cannot change`.** Bounds are fixed per series. Pick buckets at first observe. Default is `[10, 25, 50, 100, 250, 500, 1000]` (short durations in ms). Set `buckets` for other units.

**Events / logs missing.** Buffer full → new rows drop, `wardx.internal.events_dropped` / `logs_dropped` increment. Prefer counters on hot paths.

**Frames never arrive.** Ingest down, or the SDK discarded a failed batch. This is expected. Do not add a retry of those frames.

**Agent asking to call `/v1/sync` or MCP from app code.** SDK speaks HTTP sync only. Agents speak MCP on the server process.

**No exposures after an experiment ships.** The app is reading the knob with no subject. On a single-user process, call `identify(userId)` after login. On a `game-server`, pass `{ subjectId }` on each `config.get`. Do not `identify()` on a process that serves many users.
