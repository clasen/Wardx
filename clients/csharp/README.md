# Wardx for C# / Unity

C# SDK for Wardx. Same wire contract as the Node SDK: `POST /v1/sync`, JSON + gzip, header `X-Wardx-Key`.

This SDK talks to that server. See [Wardx](https://github.com/clasen/Wardx).

A measure call changes local memory only. Delivery is at-most-once. A failed sync discards that batch. Remote Config is a local read of the last snapshot.

**WARNING:** The SDK does not write a disk queue. The SDK does not retry the same frames.

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

Unity 2021.3 or later, or .NET Standard 2.1.

## Install

**Unity.** Package Manager → Add package from git URL:

```
https://github.com/clasen/Wardx.git?path=clients/csharp/Runtime
```

Pin a release with `#v0.1.6`. In `Packages/manifest.json`:

```json
"com.wardx.sdk": "https://github.com/clasen/Wardx.git?path=clients/csharp/Runtime#v0.1.6"
```

**Unity (this checkout).** Package Manager → Add package from disk → `clients/csharp/Runtime/package.json`.

**C# / .NET.** Reference `clients/csharp/Runtime/Wardx.csproj`.

> [!NOTE]
> **Agent skills.** Teach the agent this SDK with the [Skills CLI](https://skills.sh):
>
> ```bash
> npx skills add https://github.com/clasen/Wardx --skill wardx-unity
> npx skills add https://github.com/clasen/Wardx --skill wardx-csharp
> ```

## Start

Required keys: `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`. `Role` cannot be `*`. Use `unity` for a player build.

```csharp
using Wardx;

var wardx = WardxClient.Create(new WardxOptions
{
    Endpoint = "http://127.0.0.1:8787",
    ProjectKey = "dev_project_key",
    Project = "demo",
    Role = "unity",
    AppVersion = "0.1.0",
    Environment = "production"
});

wardx.Log.Info("match_started", Dims.Of("mode", "ranked"));
wardx.Event("match.started", Dims.Of("mode", "ranked"));
wardx.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
wardx.Gauge("players.online").Set(12);
wardx.Histogram("request.duration").Observe(42);

var end = wardx.Timer("matchmaking.duration");
end.Stop(Dims.Of("result", "success"));

await wardx.FlushAsync();
await wardx.ShutdownAsync();
```

In Unity you can also add `WardxBehaviour` to a GameObject and set the same fields in the Inspector. `AppVersion` uses `Application.version` when the field is empty.

Unity sends `sdk.name = wardx-unity` and `client.platform = unity`. A plain C# process sends `wardx-csharp` / `csharp`.

## Signals

| Need | Call |
| --- | --- |
| How many / how much | `Counter(name, dims).Inc()` or `.Add(n)` |
| Last known size | `Gauge(name, dims).Set(value)` |
| Distribution | `Histogram(name, dims, buckets).Observe(value)` |
| Elapsed time | `Timer(name, dims)` then `Stop()` |
| Discrete product fact | `Event(name, attrs)` |
| Volume funnel (drop-off between steps) | one `Event` + one `Counter` per step name |
| Failure | `Log.Error(message, attrs)` with a clipped `stack` or provider `code`. MCP returns the row; the agent edits source via the role `path`/`git`. |
| Play-session length | App clock; on end `Histogram("session.duration")` + `Counter("session.time_ms").Add(ms)` + `Experiment.Goal("session.duration", value: ms)`. Not the SDK `sessionId`. |
| Remote value / variant | `Config.Get(key, fallback)` after `Identify(userId)`, or `Config.Get(key, fallback, subjectId)` |
| Experiment conversion | `Experiment.Goal(name)` after `Identify`, or `Experiment.Goal(name, subjectId)` |

A counter in a frame is a window delta. Do not put a user id on a metric dimension. Histogram `Observe(value, attrs)` keeps attrs only for the window max (`exemplar`).

## Funnels

Wardx compares how often each named step fired. It does not reconstruct a per-user path.

Give each step its own name. Emit the event and increment a counter of the same name. Read the drop in `get_aggregates`. Event attrs do not split that count. `Experiment.Goal` is one conversion or one quantitative value, not an N-step funnel.

```csharp
wardx.Event("onboarding.start", Dims.Of("channel", channel));
wardx.Counter("onboarding.start", Dims.Of("channel", channel)).Inc();

wardx.Event("onboarding.done");
wardx.Counter("onboarding.done").Inc();
wardx.Experiment.Goal("onboarding.done", userId);
```

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Session duration

A play session is an interval you own (app open to close, login to logout). The SDK `sessionId` identifies the envelope. It is not that clock.

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

`get_aggregates` reads fleet `session.time_ms`. `analyze_experiment` compares `goalMean` by variant and returns a `decision`. Close a winner with `ship_experiment`. Instrument `level.start` / `level.fail` / `level.complete` as a volume funnel. Do not also emit `Experiment.Goal` for those steps if the experiment goal is session duration. See the Node SDK use cases 14 and 15.

## Remote Config and experiments

`Identify(userId)` sets the default subject for this instance. Later `Config.Get` and `Experiment.Goal` use it. A per-call `subjectId` overrides it. `Identify(null)` clears it.

Use `Identify` on a single-user process (Unity player, desktop). On a process that serves many users, pass `subjectId` on each call. Do not `Identify()` there: it is process-wide and would mix users. Use a stable account id, not the SDK `sessionId`.

With no subject, `Get` returns Remote Config and that call is not in an experiment. `Experiment.Goal` without a subject throws.

```csharp
wardx.Identify(userId);
var timeoutMs = wardx.Config.Get("matchmaking.timeoutMs", 5000);
var delayMs = wardx.Config.Get("message.delayMs", 1000);
wardx.Experiment.Goal("message.sent", value: 1);

var otherDelayMs = wardx.Config.Get("message.delayMs", 1000, otherUserId);
```

Until a sync applies a snapshot, `Get` returns the fallback. Assignment is local and deterministic: the same `subjectId`, experiment `id`, and `salt` always map to the same variant. You do not persist the group. Changing the experiment `salt` redistributes the population. Exposure is event `experiment.exposure` with a hashed subject. The raw id does not go on the wire.

## Lifecycle

`FlushAsync` sends pending frames and leaves timers running. `ShutdownAsync` stops timers, sends pending frames, and closes the transport. In Unity, `OnApplicationQuit` stops timers without blocking the main thread on HTTP.

Pass `new ConsoleTracer()` as `WardxOptions.Tracer` while instrumenting. It does not go over the wire.

## Protocol

See [docs/PROTOCOL.md](../../docs/PROTOCOL.md). Operational defaults match `packages/core/defaults.json`.
