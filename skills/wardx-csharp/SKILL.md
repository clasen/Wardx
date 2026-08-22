---
name: wardx-csharp
description: Instruments C# / .NET with the Wardx SDK (WardxClient.Create) — counters, gauges, histograms, timers, events, logs, Remote Config, experiment assignment, and volume funnels. Use when the user mentions Wardx, WardxClient, WardxOptions, Config.Get, Experiment.Goal, Identify, clients/csharp, Wardx.csproj, or asks to add telemetry, metrics, events, logs, or A/B assignment in a C# process that is not Unity. Also use when changing non-Unity code in clients/csharp. Do not use for MCP tools, catalog onboarding, or ingest control — that belongs to wardx-server. Do not use for Node.js (wardx) or a Unity player (wardx-unity).
---

# Wardx C# SDK

`clients/csharp` is the C# runtime. A plain C# process sends `sdk.name = wardx-csharp` and `client.platform = csharp`. Assignment and `Config.Get` run here. HTTP `POST /v1/sync` lives here. MCP does not.

- A measure call changes local memory only. It does not send. It does not return a Task.
- Delivery is at-most-once. A failed sync discards that batch. There is no disk queue and no retry of the same frames.
- Remote Config is always a local read of the last snapshot.
- The SDK sends names. Descriptions live in the server catalog.

Control plane (MCP, catalog, experiments as definitions, aggregates) is the **wardx-server** skill. This skill writes C# / .NET instrumentation. A Unity player is the **wardx-unity** skill.

Package internals when editing `clients/csharp`: [references/package.md](references/package.md).

## First actions

1. Reference `clients/csharp/Runtime/Wardx.csproj`. `using Wardx;`.
2. Call `WardxClient.Create` with every required key. Do not invent fallbacks for missing keys.
3. Pick the cheapest signal that answers the question (table below).
4. Call `ShutdownAsync` when the process stops. `FlushAsync` sends now and leaves timers running.

Required `WardxOptions` keys: `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`. `Role` is an open name (`game-server`, `desktop`, `csharp`). It cannot be `*`. `Project` must match the server mapping. `ProjectKey` is header `X-Wardx-Key`.

Optional: `PrivacySalt` (empty → `ProjectKey`), `Tracer`, and keys in `SdkDefaults` / `packages/core/defaults.json`. A bootstrap sync starts immediately; later syncs use `SyncIntervalMs` with jitter.

## Choose a signal

Use the cheapest signal that still answers the question.

| Need | Call |
| --- | --- |
| How many / how much in this window | `Counter(name, dims).Inc()` or `.Add(n)` |
| Last known size of a set | `Gauge(name, dims).Set(value)` |
| Distribution of a sample you already have | `Histogram(name, dims, buckets).Observe(value)` |
| Elapsed time you start and stop here | `Timer(name, dims)` then `Stop()` |
| One discrete product fact | `Event(name, attrs)` plus a counter when you also need a rate |
| Drop-off between named steps (volume funnel) | one `Event` + one `Counter` per step name. Not a unique-user path. |
| Play-session length / fleet play time | App clock on start; on end `Histogram("session.duration")` + `Counter("session.time_ms").Add(ms)` + `Experiment.Goal("session.duration", value: ms)`. Optional heartbeat adds only to `session.time_ms`. Not the SDK `sessionId`. |
| Failure on a request path | `Log.Error(message, attrs)` plus a counter. A stack is an attr. MCP returns the row; the agent edits source via the role `path`/`git`. |
| Rare anomaly or purchase | `Event` (not once per user action on a busy backend) |
| Default experiment subject | `Identify(subjectId)` on a single-user process. `Identify(null)` clears. |
| Remote value / variant | `Config.Get(key, fallback)` after `Identify`, or `Config.Get(key, fallback, subjectId)` |
| Experiment conversion | `Experiment.Goal(name)` after `Identify`, or `Experiment.Goal(name, subjectId)` |

A counter in a frame is a window delta, not a lifetime total. A gauge that is never `Set` in a window is absent. Keep the series object when you increment in a loop. Build dims with `Dims.Of(...)`.

**Dimensions.** Small sets: `mode`, `route`, `code`, `source`, `result`. Values are string, number, or boolean. Never `userId`, email, or a unique id on a metric dimension. The SDK caps series per name (`MaxSeriesPerMetric`); extra series become no-ops and increment `wardx.internal.cardinality_dropped`. Histogram `Observe(value, attrs)` keeps attrs only for the window max (`exemplar`). A lookup key (`grantId`, `matchId`) belongs there, not on the series.

**Backend vs client.** If one process serves many users, increment counters in process. Do not `Event()` once per user action. Give that process its own `role` (`game-server`) so MCP does not mix it with a Unity player. Pass `subjectId` on each `Config.Get` / `Experiment.Goal`. Do not `Identify()` there: it is process-wide and would mix users.

**Funnels.** Wardx compares how often each named step fired. It does not store a user journey. Give each step its own name. Emit the event and increment a counter of the same name. Event attrs do not split the server count. `Experiment.Goal` is one conversion or one quantitative value, not an N-step funnel. Read the drop with `get_aggregates` (wardx-server).

**Economy.** Wardx is not a ledger. Wallet rows live in the application database. On the grant path: `coins.awarded` (`.Add(amount)`), `coins.grants` (`.Inc()`), `coins.award_size` histogram with exemplar. Emit `coins.anomaly` and `Log.Warn("coins_anomaly", …)` only when amount exceeds a Remote Config cap.

Do not ship catalog descriptions from the SDK. Name the metric; meaning is onboarded on the server.

## Remote Config and experiments

`Identify(userId)` sets the default subject for this instance. Later `Config.Get` and `Experiment.Goal` use it. A per-call `subjectId` overrides it. `Identify(null)` clears it. Use a stable account id, not `sessionId`.

On a single-user process (desktop), `Identify` once after login. On a process that serves many users (`game-server`), pass `subjectId` on every call. Do not `Identify()` there.

```csharp
var timeoutMs = wardx.Config.Get("matchmaking.timeoutMs", 5000, userId);
var delayMs = wardx.Config.Get("message.delayMs", 1000, userId);
wardx.Experiment.Goal("message.sent", userId, 1);
```

Until a sync applies a newer `configVersion`, `Get` returns the fallback or the last snapshot. The first `Get` with a subject in a session can emit `experiment.exposure` (`experiment`, `variant`, hashed `subject`). The raw `subjectId` never goes on the wire. Assignment is local and deterministic. Do not persist the variant. Changing `salt` redistributes; keep it when replacing the same experiment `id`.

`Experiment.Goal` needs a subject from `Identify()` or the `subjectId` argument. Without a subject, the call throws.

Do not wait for the network on the hot path. Do not invent experiment definitions in application code; the server stores them. Do not put `subjectId` on metric dimensions.

## Lifecycle

```csharp
AppDomain.CurrentDomain.ProcessExit += (_, __) => wardx.ShutdownAsync().GetAwaiter().GetResult();
```

`ShutdownAsync` is safe to call more than once. `FlushAsync` sends pending frames and leaves timers running. The SDK records in memory if ingest is down; failed syncs increment `wardx.internal.frames_failed`. The next cycle sends new data only. Do not use this SDK when loss is unacceptable.

Pass `new ConsoleTracer()` as `WardxOptions.Tracer` while instrumenting. It does not go over the wire. Omit it in production.

## Changing the SDK

When the task is code in `clients/csharp`: keep measure calls synchronous and non-blocking. HTTP, gzip, and process RSS stay in `Runtime/Client` and `Runtime/Dotnet` (`#if !UNITY`). Engine, settings, frames, and assignment stay in `Runtime/Core`. Do not add retries of the same frames or a disk queue. See [references/package.md](references/package.md).

## Examples

**User says:** "Add Wardx to this C# service."

```csharp
using Wardx;

var wardx = WardxClient.Create(new WardxOptions
{
    Endpoint = "http://127.0.0.1:8787",
    ProjectKey = "dev_project_key",
    Project = "demo",
    Role = "game-server",
    AppVersion = "2.4.1",
    Environment = "production"
});

void HandleMatchmaking()
{
    var end = wardx.Timer("matchmaking.duration", Dims.Of("route", "matchmaking"));
    wardx.Counter("http.requests", Dims.Of("route", "matchmaking")).Inc();
    try
    {
        FindMatch();
        wardx.Counter("matchmaking.ok").Inc();
        end.Stop(Dims.Of("result", "success"));
    }
    catch (Exception err)
    {
        wardx.Counter("matchmaking.error").Inc();
        wardx.Log.Error("matchmaking_failed", Dims.Of("code", err.GetType().Name));
        end.Stop(Dims.Of("result", "error"));
        throw;
    }
}
```

**User says:** "Instrument the onboarding funnel."

```csharp
wardx.Event("onboarding.start", Dims.Of("channel", channel));
wardx.Counter("onboarding.start", Dims.Of("channel", channel)).Inc();
wardx.Event("onboarding.done");
wardx.Counter("onboarding.done").Inc();
wardx.Experiment.Goal("onboarding.done", userId);
```

One name per step. Do not put `userId` on the counter.

**User says:** "A/B the message delay for a user." / "How do I Identify()?"

On a `game-server`, skip `Identify()` and pass `subjectId` on each call:

```csharp
var delayMs = wardx.Config.Get("message.delayMs", 1000, userId);
wardx.Experiment.Goal("message.sent", userId, 1);
```

On a single-user desktop process:

```csharp
wardx.Identify(userId);
var delayMs = wardx.Config.Get("message.delayMs", 1000);
wardx.Experiment.Goal("message.sent", value: 1);
```

1. Identify once on a single-user process, or pass `subjectId` per call on a multi-user process.
2. Do not define variants in the app. Point the user at MCP / wardx-server to `upsert_experiment` on an existing knob.

**User says:** "Count coin grants without exploding cardinality."

```csharp
wardx.Counter("coins.awarded", Dims.Of("source", source)).Add(amount);
wardx.Counter("coins.grants", Dims.Of("source", source)).Inc();
wardx.Histogram("coins.award_size", Dims.Of("source", source), new double[] { 10, 50, 100, 250, 500, 1000, 5000 })
    .Observe(amount, Dims.Of("grantId", id));
if (amount > wardx.Config.Get("economy.maxAward", 500, userId))
{
    wardx.Event("coins.anomaly", Dims.Of("source", source, "amount", amount, "grantId", id));
}
```

**User says:** "Log this error so an agent can fix the file."

```csharp
wardx.Counter("payment.error", Dims.Of("code", code)).Inc();
wardx.Log.Error("payment_failed", Dims.Of("name", err.GetType().Name, "code", code, "stack", clippedStack));
```

Point the user at wardx-server: `get_recent_logs`, then the role `path` / `git`.

## Troubleshooting

**`createWardx missing required keys`.** Pass every required key. The loader does not default them.

**`role cannot be *`.** `*` is a server visibility token, not an instance role.

**No Remote Config / always fallback.** Bootstrap or a later sync has not applied a snapshot yet, or `Project` / `ProjectKey` / `Role` do not match the server. The app must still run.

**Silent no-op metrics.** Series cap or invalid dimensions. Check `wardx.internal.cardinality_dropped`. Remove unique ids from dims.

**`histogram … buckets cannot change`.** Bounds are fixed per series. Default is `[10, 25, 50, 100, 250, 500, 1000]`.

**Frames never arrive.** Ingest down, or the SDK discarded a failed batch. This is expected. Do not add a retry of those frames.

**No exposures after an experiment ships.** The app is reading the knob with no subject. On a single-user process, call `Identify(userId)` after login. On a `game-server`, pass `subjectId` on each `Config.Get`. Do not `Identify()` on a process that serves many users.

**Agent asking to call `/v1/sync` or MCP from app code.** SDK speaks HTTP sync only. Agents speak MCP on the server process.
