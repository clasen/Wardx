---
name: wardx-unity
description: Instruments Unity with the Wardx C# SDK (WardxClient / WardxBehaviour) — counters, gauges, histograms, distinct HLL estimates, timers, events, logs, Remote Config, experiment assignment, and volume funnels. Use when the user mentions Wardx, WardxClient, WardxBehaviour, WardxOptions, Config.Get, Experiment.Goal, Identify, clients/csharp, com.wardx.sdk, Unity, or asks to add telemetry, metrics, events, logs, unique counts, or A/B assignment in a Unity player. Also use when changing Unity-specific code in clients/csharp. Do not use for MCP tools, catalog onboarding, or ingest control — that belongs to wardx-server. Do not use for Node.js (wardx) or a non-Unity C# process (wardx-csharp).
---

# Wardx Unity SDK

`clients/csharp` is the C# runtime. Unity sends `sdk.name = wardx-unity` and `client.platform = unity`. Assignment and `Config.Get` run here. HTTP `POST /v1/sync` lives here. MCP does not.

- A measure call changes local memory only. It does not send. It does not return a Task.
- Delivery is at-most-once. A failed sync discards that batch. There is no disk queue and no retry of the same frames.
- Remote Config is always a local read of the last snapshot.
- Remote Config must not contain secrets. The project key authenticates the project; client-selected `Role` is routing metadata, not authorization.
- The SDK sends names. Descriptions live in the server catalog.

Control plane (MCP, catalog, experiments as definitions, aggregates) is the **wardx-server** skill. This skill writes Unity player instrumentation. A plain C# / .NET process is the **wardx-csharp** skill.

Package internals when editing `clients/csharp`: [references/package.md](references/package.md).

## First actions

1. Install `com.wardx.sdk` (git URL or from disk). `using Wardx;`.
2. Create the client with every required key, or add `WardxBehaviour` and set the same fields in the Inspector. Do not invent fallbacks for missing keys. Empty `AppVersion` on the behaviour uses `Application.version`.
3. Pick the cheapest signal that answers the question (table below).
4. Call `Identify(userId)` after login. A Unity player is a single-user process.

Required `WardxOptions` keys: `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`. Use `Role = "unity"` for a player build. `Role` is routing metadata, not an authorization boundary, and cannot be `*`. `Project` must match the server mapping. `ProjectKey` is header `X-Wardx-Key`.

`PrivacySalt` is required, non-empty, stable, and project-specific; it is never derived from `ProjectKey`. Optional overrides are `Tracer` and keys in `SdkDefaults` / `packages/core/defaults.json`. `MaxFrameBytes` is at least 1024; `ExperimentStateMaxSubjects` defaults to 100000 and bounds assignment/exposure state. A bootstrap sync starts immediately; later syncs use `SyncIntervalMs` with jitter.

## Choose a signal

Use the cheapest signal that still answers the question.

| Need | Call |
| --- | --- |
| How many / how much in this window | `Counter(name, dims).Inc()` or `.Add(n)` |
| Last known size of a set | `Gauge(name, dims).Set(value)` |
| Distribution of a sample you already have | `Histogram(name, dims, buckets).Observe(value)` |
| Approximate unique identifiers without storing them | `Distinct(name, dims).Add(identifier)` |
| Elapsed time you start and stop here | `Timer(name, dims)` then `Stop()` |
| One discrete product fact | `Event(name, attrs)` plus a counter when you also need a rate |
| Drop-off between named steps (volume funnel) | one `Event` + one `Counter` per step name. Not a unique-user path. |
| Play-session length / fleet play time | App clock on start; on end `Histogram("session.duration")` + `Counter("session.time_ms").Add(ms)` + `Experiment.Goal("session.duration", value: ms)`. Optional heartbeat adds only to `session.time_ms`. Not the SDK `sessionId`. |
| Level difficulty (too hard / too easy) | Remote Config knobs + volume funnel `level.start` → `level.fail` / `level.complete`. Session duration is the A/B goal. |
| Failure on a player path | `Log.Error(message, attrs)` plus a counter. A stack is an attr. MCP returns the row; the agent edits source via the role `path`/`git`. |
| Rare anomaly or purchase | `Event` (not once per frame on the hot loop) |
| Default experiment subject | `Identify(userId)` after login. `Identify(null)` clears. |
| Remote value / variant | `Config.Get(key, fallback)` after `Identify`, or `Config.Get(key, fallback, subjectId)` |
| Experiment conversion | `Experiment.Goal(name)` after `Identify`, or `Experiment.Goal(name, subjectId)` |

A counter in a frame is a window delta, not a lifetime total. A gauge that is never `Set` in a window is absent. Keep the series object when you increment in a loop. Build dims with `Dims.Of(...)`.

**Dimensions.** Small sets: `mode`, `level`, `result`, `source`. Values are string, number, or boolean. Never `userId`, email, or a unique id on a metric dimension. The SDK caps series per name (`MaxSeriesPerMetric`); extra series become no-ops and increment `wardx.internal.cardinality_dropped`. Histogram `Observe(value, attrs)` keeps attrs only for the window max (`exemplar`). A lookup key (`grantId`, `matchId`) belongs there, not on the series.

**Distinct.** `Distinct(name, dims).Add(identifier)` hashes locally with the
required stable `PrivacySalt` and sends only a fixed mergeable HLL sketch. It
answers approximate unique counts, not identities or ordered player paths.

**Player, not backend.** This process is one user. Increment on the game loop or event handlers. Give the player `role` `unity` so MCP does not mix it with a `game-server`.

**Funnels.** Wardx compares how often each named step fired. It does not store a user journey. Give each step its own name (`onboarding.start` → `onboarding.done`, or `level.start` → `level.fail` / `level.complete`). Emit the event and increment a counter of the same name. Event attrs do not split the server count. `sessionId` is envelope identity, not a join key. `Experiment.Goal` is one conversion or one quantitative value, not an N-step funnel. Read the drop with `get_aggregates` (wardx-server).

**Session time.** The app owns the play-session clock (open to close, login to logout). Do not use `sessionId`. On end: observe `session.duration` with minute-scale buckets, add the same ms to `session.time_ms`, increment `session.ended`, emit `Experiment.Goal("session.duration", value: durationMs)` once. A heartbeat may add to `session.time_ms` only.

**Economy.** Wardx is not a ledger. Wallet rows live in the game database. On the grant path: `coins.awarded` (`.Add(amount)`), `coins.grants` (`.Inc()`), `coins.award_size` histogram with exemplar. Emit `coins.anomaly` and `Log.Warn("coins_anomaly", …)` only when amount exceeds a Remote Config cap.

Do not ship catalog descriptions from the SDK. Name the metric; meaning is onboarded on the server.

## Remote Config and experiments

`Identify(userId)` sets the default subject for this instance. Later `Config.Get` and `Experiment.Goal` use it. A per-call `subjectId` overrides it. `Identify(null)` clears it. Use a stable account id, not `sessionId`.

Call `Identify` once after login. Do not skip it on a player: a read with no subject returns Remote Config and does not expose.

```csharp
wardx.Identify(userId);
var timeoutMs = wardx.Config.Get("matchmaking.timeoutMs", 5000);
var delayMs = wardx.Config.Get("message.delayMs", 1000);
wardx.Experiment.Goal("message.sent", value: 1);
```

Until a sync applies a newer `configVersion`, `Get` returns the fallback or the last snapshot. The first `Get` with a subject in a session can emit `experiment.exposure` (`experiment`, `variant`, hashed `subject`). The raw `subjectId` never goes on the wire. Assignment is local and deterministic. Do not persist the variant. Changing `salt` redistributes; keep it when replacing the same experiment `id`.

`Experiment.Goal` needs a subject from `Identify()` or the `subjectId` argument. It emits only for an assignment exposed in this SDK instance whose experiment `goalMetric` matches the call name. Without a subject, the call throws. There is no legacy match-all fallback.

Do not wait for the network on the game loop. Do not invent experiment definitions in player code; the server stores them. Do not put `subjectId` on metric dimensions.

## Lifecycle

`FlushAsync` sends pending frames and leaves timers running. `ShutdownAsync` stops timers, sends pending frames, and closes the transport. In Unity, `OnApplicationQuit` / `OnDestroy` call `Stop()` — they must not block the main thread on HTTP.

Pass `new ConsoleTracer()` as `WardxOptions.Tracer` while instrumenting. It does not go over the wire. Omit it in production.

## Changing the SDK

When the task is code in `clients/csharp`: keep measure calls synchronous and non-blocking. Unity transport, host, and `WardxBehaviour` stay under `Runtime/Unity` (`#if UNITY`). Do not add retries of the same frames or a disk queue. See [references/package.md](references/package.md).

## Examples

**User says:** "Add Wardx to this Unity game."

Add `WardxBehaviour` to a GameObject and set `Endpoint`, `ProjectKey`, `Project`, `Role` (`unity`), `Environment`. Or:

```csharp
using Wardx;

var wardx = WardxClient.Create(new WardxOptions
{
    Endpoint = "http://127.0.0.1:8787",
    ProjectKey = "dev_project_key",
    Project = "demo",
    Role = "unity",
    AppVersion = Application.version,
    Environment = "production",
    PrivacySalt = "demo-subject-hash-v1"
});
```

**User says:** "Instrument the onboarding funnel."

```csharp
wardx.Event("onboarding.start", Dims.Of("channel", channel));
wardx.Counter("onboarding.start", Dims.Of("channel", channel)).Inc();
wardx.Event("onboarding.done");
wardx.Counter("onboarding.done").Inc();
wardx.Experiment.Goal("onboarding.done", userId);
```

One name per step. Compare those counts. Do not put `userId` on the counter.

**User says:** "A/B the message delay for a player." / "How do I Identify()?"

```csharp
wardx.Identify(userId);
var delayMs = wardx.Config.Get("message.delayMs", 1000);
wardx.Experiment.Goal("message.sent", value: 1);
```

1. `Identify` once after login.
2. Do not define variants in the app. Point the user at MCP / wardx-server to `upsert_experiment` on an existing knob.

**User says:** "Measure session duration." / "A/B difficulty so people play longer."

```csharp
wardx.Identify(userId);
var started = DateTime.UtcNow;
var enemyHp = wardx.Config.Get("level.3.enemyHp", 100);
// … play session …
var durationMs = (DateTime.UtcNow - started).TotalMilliseconds;
wardx.Histogram("session.duration", null, new double[] { 30000, 60000, 180000, 300000, 600000, 1200000, 1800000, 3600000 })
    .Observe(durationMs);
wardx.Counter("session.time_ms").Add(durationMs);
wardx.Counter("session.ended").Inc();
wardx.Experiment.Goal("session.duration", value: durationMs);
```

Instrument `level.start` / `level.fail` / `level.complete` as a volume funnel. Do not emit `Experiment.Goal` for those steps if the experiment goal is session duration.

**User says:** "Log this error so an agent can fix the file."

```csharp
wardx.Counter("purchase.error", Dims.Of("code", code)).Inc();
wardx.Log.Error("purchase_failed", Dims.Of("code", code, "stack", clippedStack));
```

Point the user at wardx-server: `get_recent_logs`, then the role `path` / `git`.

## Troubleshooting

**`createWardx missing required keys`.** Pass every required key. The loader does not default them. On `WardxBehaviour`, empty `AppVersion` is the only fill (`Application.version`).

**`role cannot be *`.** `*` is a server visibility token, not an instance role.

**No Remote Config / always fallback.** Bootstrap or a later sync has not applied a snapshot yet, or `Project` / `ProjectKey` / `Role` do not match the server. The game must still run.

**Silent no-op metrics.** Series cap or invalid dimensions. Check `wardx.internal.cardinality_dropped`. Remove unique ids from dims.

**`histogram … buckets cannot change`.** Bounds are fixed per series. Default is `[10, 25, 50, 100, 250, 500, 1000]`. Set buckets for session duration and other units.

**Frames never arrive.** Ingest down, or the SDK discarded a failed batch. This is expected. Do not add a retry of those frames.

**No exposures after an experiment ships.** The player is reading the knob with no subject. Call `Identify(userId)` after login.

**Agent asking to call `/v1/sync` or MCP from game code.** SDK speaks HTTP sync only. Agents speak MCP on the server process.
