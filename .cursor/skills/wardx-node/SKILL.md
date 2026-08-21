---
name: wardx-node
description: Instruments Node.js with the Wardx SDK (wardx / createWardx) — counters, gauges, histograms, timers, events, logs, Remote Config, and experiment assignment. Use when the user mentions wardx, createWardx, config.get, experiment.goal, createConsoleTracer, packages/node, packages/core, @wardx/core, or asks to add telemetry, metrics, events, logs, or A/B assignment in application code. Also use when changing the Node SDK or the core engine. Do not use for MCP tools, catalog onboarding, ingest control, or POST /v1/sync from an agent — that belongs to wardx-server.
---

# Wardx Node SDK

`wardx` is the Node.js runtime. `@wardx/core` is the in-process engine. Assignment and `config.get` run here. HTTP `POST /v1/sync` lives here. MCP does not.

- A measure call changes local memory only. It does not send. It does not return a Promise.
- Delivery is at-most-once. A failed sync discards that batch. There is no disk queue and no retry of the same frames.
- Remote Config is always a local read of the last snapshot.
- The SDK sends names. Descriptions live in the server catalog.

Control plane (MCP, catalog, experiments as definitions, aggregates) is the **wardx-server** skill. This skill writes application instrumentation and SDK code.

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
| Failure on a request path | `log.error(message, attrs)` plus a counter. A stack is an attr. |
| Rare anomaly or purchase | `event` (not once per grant on a busy backend) |
| Remote value / variant | `config.get(key, fallback, context)` |
| Experiment conversion | `experiment.goal(name, { subjectId })` |

A counter in a frame is a window delta, not a lifetime total. A gauge that is never `set` in a window is absent. Keep the series object when you increment in a loop.

**Dimensions.** Small sets: `mode`, `route`, `code`, `source`, `result`. Values are string, number, or boolean. Never `userId`, email, or a unique id on a metric dimension. The SDK caps series per name (`maxSeriesPerMetric`); extra series become no-ops and increment `wardx.internal.cardinality_dropped`. Histogram `observe(value, attrs)` keeps attrs only for the window max (`exemplar`). A lookup key (`grantId`, `matchId`) belongs there, not on the series.

**Backend vs client.** If one process serves many users, increment counters in process. Do not `event()` once per user action. Give that process its own `role` so MCP does not mix it with a player client.

**Economy.** Wardx is not a ledger. Wallet rows live in the application database. On the grant path: `coins.awarded` (`.add(amount)`), `coins.grants` (`.inc()`), `coins.award_size` histogram with exemplar. Emit `coins.anomaly` only when amount exceeds a Remote Config cap.

Do not ship catalog descriptions from the SDK. Name the metric; meaning is onboarded on the server.

## Remote Config and experiments

```js
const timeoutMs = wardx.config.get('matchmaking.timeoutMs', 5000);
const delayMs = wardx.config.get('message.delayMs', 1000, { subjectId: userId });
wardx.experiment.goal('message.sent', { subjectId: userId, value: 1 });
```

Resolution:

1. Key missing from the snapshot → fallback.
2. No `subjectId` → Remote Config value.
3. Experiment applies to the subject → variant value.

Until a sync applies a newer `configVersion`, `config.get` returns the fallback or the last snapshot. The first `config.get` with a `subjectId` in a session can emit `experiment.exposure` (`experiment`, `variant`, hashed `subject`). The raw `subjectId` never goes on the wire. Assignment is local and deterministic (same subject, experiment, salt → same variant).

`experiment.goal` requires `subjectId`. It emits event `experiment.goal` with known assignments for that subject. Optional `value`.

Do not wait for the network on the hot path. Do not invent experiment definitions in application code; the server stores them.

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

**User says:** "A/B the message delay for a user."

1. Read with `subjectId`. Record a goal on the conversion path.
2. Do not define variants in the app. Point the user at MCP / wardx-server to `upsert_experiment` on an existing knob.

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
