# Wardx for C# / Unity

C# SDK for Wardx. It implements Protocol v1 over `POST /v1/sync`, JSON + gzip, and header `X-Wardx-Key`. Treat Node/C#/Unity behavior as equivalent only where shared fixtures or a real HTTP interoperability test prove it.

This SDK talks to that server. See [Wardx](https://github.com/clasen/Wardx). Architecture: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

A measure call changes local memory only. Delivery is at-most-once. A failed sync discards that batch. Remote Config is a local read of the last snapshot. Physical frames are serialized and split to `MaxFrameBytes` with consecutive sequence numbers; an individually oversized row is counted in `wardx.internal.frame_rows_dropped`.

**WARNING:** The SDK does not write a disk queue. The SDK does not retry the same frames.

Unity 2021.3 or later, or .NET Standard 2.1.

## Install

**Unity.** Package Manager → Add package from git URL:

```
https://github.com/clasen/Wardx.git?path=clients/csharp/Runtime
```

Pin a release with `#v0.5.0`. In `Packages/manifest.json`:

```json
"com.wardx.sdk": "https://github.com/clasen/Wardx.git?path=clients/csharp/Runtime#v0.5.0"
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

Required keys: `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`, `PrivacySalt`. `PrivacySalt` must be stable, non-empty, and project-specific; it is never derived from `ProjectKey`. `Role` cannot be `*`. Use `unity` for a player build. The project key authenticates only the project; client-selected `Role` is routing metadata, not authorization. Never put secrets in Remote Config.

```csharp
using Wardx;

var wardx = WardxClient.Create(new WardxOptions
{
    Endpoint = "http://127.0.0.1:8787",
    ProjectKey = "dev_project_key",
    Project = "demo",
    Role = "unity",
    AppVersion = "0.1.0",
    Environment = "production",
    PrivacySalt = "demo-subject-hash-v1"
});

wardx.Log.Info("match_started", Dims.Of("mode", "ranked"));
wardx.Event("match.started", Dims.Of("mode", "ranked"));
wardx.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
wardx.Gauge("players.online").Set(12);
wardx.Histogram("request.duration").Observe(42);
wardx.Distinct("shot.traffic.hids", Dims.Of("result", "violating")).Add(hid);

var end = wardx.Timer("matchmaking.duration");
end.Stop(Dims.Of("result", "success"));

await wardx.FlushAsync();
await wardx.ShutdownAsync();
```

In Unity you can also add `WardxBehaviour` to a GameObject and set the same fields in the Inspector. `AppVersion` uses `Application.version` when the field is empty.

Unity sends `sdk.name = wardx-unity` and `client.platform = unity`. A plain C# process sends `wardx-csharp` / `csharp`.

Each `WardxClient.Create(...)` SDK instance creates its own `instanceId` and `sessionId`. They are not process-wide singletons or subject/journey keys.

## Signals

| Need | Call |
| --- | --- |
| How many / how much | `Counter(name, dims).Inc()` or `.Add(n)` |
| Last known size | `Gauge(name, dims).Set(value)` |
| Distribution | `Histogram(name, dims, buckets).Observe(value)` |
| Approximate unique count | `Distinct(name, dims).Add(identifier)` |
| Elapsed time | `Timer(name, dims)` then `Stop()` |
| Discrete product fact | `Event(name, attrs)` |
| Volume funnel (drop-off between steps) | one `Event` + one `Counter` per step name |
| Failure | `Log.Error(message, attrs)` with a clipped `stack` or provider `code`. MCP returns the row; the agent edits source via the role `path`/`git`. |
| Play-session length | App clock; on end `Histogram("session.duration")` + `Counter("session.time_ms").Add(ms)` + `Experiment.Goal("session.duration", value: ms)`. Not the SDK `sessionId`. |
| Remote value / variant | `Config.Get(key, fallback)` after `Identify(userId)`, or `Config.Get(key, fallback, subjectId)` |
| Experiment conversion | `Experiment.Goal(name)` after `Identify`, or `Experiment.Goal(name, subjectId)` |

A counter in a frame is a window delta. Do not put a user id on a metric dimension. Histogram `Observe(value, attrs)` keeps attrs only for the window max (`exemplar`).

`Distinct` hashes each identifier locally with `PrivacySalt` and updates a fixed
HyperLogLog (`p=9`, 512 registers, about 4.6% standard error). Only the sketch
is serialized. Keep the same stable salt on every worker and across the hour/day
range being compared; Wardx never stores or returns the identifier.

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

Use `Identify` on a single-user process (Unity player, desktop). On a process that serves many users, pass `subjectId` on each call. Do not share one SDK instance's default there; it would mix users. Use a stable account id, not the SDK `sessionId`.

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

See [docs/PROTOCOL.md](../../docs/PROTOCOL.md). Operational defaults match `packages/core/defaults.json`: `MaxFrameBytes` is at least `1024`, and `ExperimentStateMaxSubjects` defaults to `100000` to bound assignment/exposure state in this SDK instance.

Verify the C# suite, real CLI interoperability, formatting, and SDK analyzers from the repository root:

```bash
npm run test:csharp
npm run check:csharp
```

## User retention

Call `wardx.RetentionActivity(userId)` when the user performs the activity you
choose to count as a return. The method is available on `WardxClient` and
`WardxCore`, including Unity. It requires an explicit nonblank, stable user ID;
`Identify()` does not supply a fallback. All clients of a project must use the
same activity definition and stable `PrivacySalt`.

Only salted hashes are sent. The server persists project-wide first-activity
cohorts and exact received-user counts for activity **on** D1, D7 and D30, using
UTC calendar days. Repeated sessions and devices with the same identity do not
increase a day's count. A changed salt is rejected. Earlier delayed activity
can correct the cohort. Separate production and test populations by project.

Read results through MCP `get_retention` using inclusive `from` and exclusive
`to` cohort dates (`YYYY-MM-DD`). Days that have not fully elapsed return
`pending` with null count and rate. Rates are fractions from 0 to 1.
This retains the SDK's bounded buffer and at-most-once delivery: dropped or
failed batches can bias retention. Use a server that supports retention.
