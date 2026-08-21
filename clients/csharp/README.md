# Wardx for C# / Unity

C# SDK for Wardx. Same wire contract as the Node SDK: `POST /v1/sync`, JSON + gzip, header `X-Wardx-Key`.

A measure call changes local memory only. Delivery is at-most-once. A failed sync discards that batch. Remote Config is a local read of the last snapshot.

**WARNING:** The SDK does not write a disk queue. The SDK does not retry the same frames.

Unity 2021.3 or later, or .NET Standard 2.1.

## Install

**Unity.** Package Manager → Add package from disk → `clients/csharp/Runtime/package.json`.

**C# / .NET.** Reference `clients/csharp/Runtime/Wardx.csproj`.

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
| Failure | `Log.Error(message, attrs)` |
| Remote value / variant | `Config.Get(key, fallback, subjectId)` |
| Experiment conversion | `Experiment.Goal(name, subjectId)` |

A counter in a frame is a window delta. Do not put a user id on a metric dimension. Histogram `Observe(value, attrs)` keeps attrs only for the window max (`exemplar`).

## Funnels

Wardx compares how often each named step fired. It does not reconstruct a per-user path.

Give each step its own name. Emit the event and increment a counter of the same name. Read the drop in `get_aggregates`. Event attrs do not split that count. `Experiment.Goal` is one conversion, not an N-step funnel.

```csharp
wardx.Event("onboarding.start", Dims.Of("channel", channel));
wardx.Counter("onboarding.start", Dims.Of("channel", channel)).Inc();

wardx.Event("onboarding.done");
wardx.Counter("onboarding.done").Inc();
wardx.Experiment.Goal("onboarding.done", userId);
```

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Remote Config

```csharp
var timeoutMs = wardx.Config.Get("matchmaking.timeoutMs", 5000);
var delayMs = wardx.Config.Get("message.delayMs", 1000, userId);
wardx.Experiment.Goal("message.sent", userId, 1);
```

Until a sync applies a snapshot, `Get` returns the fallback. Assignment is local and deterministic. Exposure is event `experiment.exposure` with a hashed subject.

## Lifecycle

`FlushAsync` sends pending frames and leaves timers running. `ShutdownAsync` stops timers, sends pending frames, and closes the transport. In Unity, `OnApplicationQuit` stops timers without blocking the main thread on HTTP.

Pass `new ConsoleTracer()` as `WardxOptions.Tracer` while instrumenting. It does not go over the wire.

## Protocol

See [docs/PROTOCOL.md](../../docs/PROTOCOL.md). Operational defaults match `packages/core/defaults.json`.
