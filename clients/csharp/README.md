# Wardx for C# / Unity

C# SDK for Wardx. It implements Protocol v1 over `POST /v1/sync`, JSON + gzip, and header `X-Wardx-Key`. Treat Node/C#/Unity behavior as equivalent only where shared fixtures or a real HTTP interoperability test prove it.

This SDK talks to that server. See [Wardx](https://github.com/clasen/Wardx). Architecture: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

A measure call changes local memory only. Delivery is at-most-once. A failed sync discards that batch. Remote Config is a local read of the last snapshot. Physical frames are serialized and split to `MaxFrameBytes` with consecutive sequence numbers; an individually oversized row is counted in `wardx.internal.frame_rows_dropped`.

**WARNING:** The SDK does not write a disk queue. The SDK does not retry the same frames.

Unity 2021.3 or later, or .NET Standard 2.1.

## Disable the SDK

`Enabled` defaults to `true`. Set it when creating the client:

```csharp
var wardx = WardxClient.Create(new WardxOptions { Enabled = false });
var requests = wardx.Counter("requests");
requests.Inc();
await wardx.ShutdownAsync();
```

When disabled, credentials and other connection options are unnecessary. Metric
handles, timers, events, logs, identity, retention, and experiment goals do nothing.
The client does not initialize the telemetry engine, transport, or scheduler,
and does not hash identifiers or call the tracer. `FlushAsync()` and
`ShutdownAsync()` complete immediately; `Stop()` and `Dispose()` are safe.
`Config.Get(key, fallback)` returns the supplied fallback. A supplied custom
transport is neither used nor closed.

The mode is fixed at creation; changing the options afterward does not toggle it.
Cached metric handles remain safe to call, including after shutdown. This applies
to both .NET and Unity.

## Install

**Unity.** Package Manager → Add package from git URL:

```
https://github.com/clasen/Wardx.git?path=clients/csharp/Runtime
```

Release `#v0.8.0` includes disabled mode and the optional enum API. In
`Packages/manifest.json`:

```json
"com.wardx.sdk": "https://github.com/clasen/Wardx.git?path=clients/csharp/Runtime#v0.8.0"
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

## Recommended: keep handles as fields

Create metric handles once per client and stable name/dimension combination,
then reuse them in handlers, callbacks, and loops. This avoids repeated dimension
validation, series-key construction, and registry lookup. Normal aggregation
windows and flushes reset values, not handles. Rebind when replacing the client;
do not mutate a dimension dictionary to retarget an existing handle.

For varying dimensions, bind one recorder per application-owned, bounded value
set (mode, region, source). Never build an unbounded handle cache keyed by user
IDs or arbitrary input. Keep histogram buckets fixed. Timer tokens measure one
operation: create a fresh token for each operation, not one token for the client.
For a hot duration path, reuse a histogram and observe an application-measured
elapsed duration instead. Events, logs, retention, and experiment goals remain
per-occurrence calls.

In Unity, keep metric handles as fields in the telemetry owner. Bind them after
the persistent client is created, before gameplay callbacks. This plain C#
recorder can be a field of a MonoBehaviour or a .NET service; it does not create
another client or own shutdown. Create one recorder per supported mode.

```csharp
using Wardx;

public sealed class MatchTelemetry
{
    readonly ICounter completed;
    readonly IHistogram duration;

    public MatchTelemetry(WardxClient wardx, string mode)
    {
        completed = wardx.Counter("match.completed", Dims.Of("mode", mode));
        duration = wardx.Histogram("match.duration_ms", Dims.Of("mode", mode),
            new double[] { 30000, 60000, 180000, 600000, 1800000 });
    }

    public void OnCompleted(double durationMs)
    {
        completed.Inc();
        duration.Observe(durationMs);
    }
}
```

The only metric-name strings are in the constructor; callbacks call typed fields.
The same code works with `Enabled = false`. If the application already uses enums,
keep them in the bindings; they are an optional naming layer, not a performance
replacement for stored handles. See [Optional enums](#optional-enums).

## Start

| Required option | Meaning |
| --- | --- |
| `Endpoint` | Ingest base URL, for example `http://127.0.0.1:8787`. |
| `ProjectKey` | Project credential sent as `X-Wardx-Key`. |
| `Project` | Project name matching the server mapping. |
| `Role` | Routing name such as `unity`, `desktop`, or `game-server`. |
| `AppVersion` | Application version. |
| `Environment` | Environment name. |
| `PrivacySalt` | Stable, project-specific salt for one-way subject hashes. |

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
var matchCompleted = wardx.Counter("match.completed", Dims.Of("mode", "ranked"));
matchCompleted.Inc();
var playersOnline = wardx.Gauge("players.online");
playersOnline.Set(12);
var requestDuration = wardx.Histogram("request.duration");
requestDuration.Observe(42);
var shotTrafficHids = wardx.Distinct("shot.traffic.hids", Dims.Of("result", "violating"));
shotTrafficHids.Add(hid);

var end = wardx.Timer("matchmaking.duration");
end.Stop(Dims.Of("result", "success"));

await wardx.FlushAsync();
await wardx.ShutdownAsync();
```

In Unity you can also add `WardxBehaviour` to a GameObject and set the same fields in the Inspector. `AppVersion` uses `Application.version` when the field is empty.

Unity sends `sdk.name = wardx-unity` and `client.platform = unity`. A plain C# process sends `wardx-csharp` / `csharp`.

Each `WardxClient.Create(...)` SDK instance creates its own `instanceId` and `sessionId`. They are not process-wide singletons or subject/journey keys.

The standard `Create(options)` starts a bootstrap sync immediately, then syncs
on `SyncIntervalMs` with jitter. Defaults are 15 seconds and a factor from 0.85
to 1.15. Optional `WardxOptions` fields override the centralized SDK defaults;
see [Settings.cs](Runtime/Core/Settings.cs) and [SdkDefaults.cs](Runtime/Core/SdkDefaults.cs).
The overload accepting an `ISyncTransport` does not attach a scheduler; its
caller drives flush and shutdown.

Measure calls neither send HTTP nor return tasks. Keep a metric handle when
measuring in a loop. Names go over the wire; descriptions belong in the server
catalog, supplied through server configuration or MCP onboarding.

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

## Count occurrences or quantities

Use a counter for requests, completed matches, or awarded currency:

```csharp
var completed = wardx.Counter("match.completed", Dims.Of("mode", "ranked"));
completed.Inc();
var coinsAwarded = wardx.Counter("coins.awarded", Dims.Of("source", "match"));
coinsAwarded.Add(50);
```

`Inc()` adds one; `Add(n)` adds a finite number. Each name and dimension set
identifies a series. Frames contain window deltas, not lifetime totals. At
`MaxSeriesPerMetric`, a new series returns a no-op handle. Keep dimension values
to small sets such as mode, region, or result.

## Record a current value

Use a gauge for the latest player count or queue depth:

```csharp
var playersOnline = wardx.Gauge("players.online", Dims.Of("region", "south-america"));
playersOnline.Set(12);
var matchmakingQueueDepth = wardx.Gauge("matchmaking.queue_depth");
matchmakingQueueDepth.Set(3);
```

`Set(value)` requires a finite number and replaces the previous value. The
frame contains the last value and its timestamp. A series with no `Set` in
that window is omitted. Gauges do not expose `Inc()`.

## Record a distribution

Use a histogram when you already have a numeric sample:

```csharp
var httpDurationMs = wardx.Histogram("http.duration_ms", Dims.Of("route", "checkout"));
httpDurationMs.Observe(42);
wardx.Histogram("http.payload_bytes", buckets: new double[] { 256, 1024, 4096, 16384, 65536 })
    .Observe(2048);
var coinsAwardSize = wardx.Histogram("coins.award_size");
coinsAwardSize.Observe(50, Dims.Of("grantId", "grant-42"));
```

Frames contain count, sum, min, max, and buckets. Default bounds are
`[10, 25, 50, 100, 250, 500, 1000]`; choose bounds appropriate to the unit.
Bounds must be finite and strictly increasing. Changing the buckets of an
existing series throws. A sample above the last bound contributes to the
summary but not to a bucket.

`Observe(value, attrs)` retains attrs only for the window maximum as an
`exemplar`. Use a lookup key such as `grantId` to find the corresponding record
in your own database. Exemplar attrs obey dimension limits.

## Measure elapsed time

Use a timer when the SDK should measure an operation in milliseconds:

```csharp
var timer = wardx.Timer("matchmaking.duration", Dims.Of("mode", "ranked"));
try
{
    await FindMatchAsync();
    timer.Stop(Dims.Of("result", "success"));
}
catch
{
    timer.Stop(Dims.Of("result", "error"));
    throw;
}
```

`FindMatchAsync` represents application work. `Stop` observes a histogram;
end dimensions merge with start dimensions, replacing matching keys. Stop the
token when the operation ends; subsequent `Stop` calls on that token do nothing.

## Record a product event

Use an event for an individual product fact and a counter for its aggregate:

```csharp
wardx.Event("purchase", Dims.Of("product", "coins-small", "currency", "USD", "amount", 2.99));
var purchaseCount = wardx.Counter("purchase.count", Dims.Of("product", "coins-small"));
purchaseCount.Inc();
var purchaseAmount = wardx.Counter("purchase.amount", Dims.Of("currency", "USD"));
purchaseAmount.Add(2.99);
```

An event is a buffered row; a counter adds to a window sum. Prefer a counter
when the aggregate is all you need. When the event buffer is full, the new
event is discarded and `wardx.internal.events_dropped` increases.

Dimensions and attrs accept string, enum, finite numeric, and boolean values, not
nested objects. `Dims.Of` builds up to three pairs; for more, use a `Dims`
collection initializer. Metric dimension limits come from `MaxDimensionKeys`
and `MaxDimensionValueLength`. Event and log attrs must fit the server's
`maxAttributeKeys` and `maxAttributeValueLength`; see the [protocol](../../docs/PROTOCOL.md).

## Detect abnormal currency or point grants

Record quantity, frequency, and grant size together. This example assumes the
application has already committed the grant in its own database:

```csharp
public sealed class GrantTelemetry
{
    readonly WardxClient wardx;
    readonly string source;
    readonly ICounter awarded;
    readonly ICounter grants;
    readonly IHistogram size;

    public GrantTelemetry(WardxClient wardx, string source)
    {
        this.wardx = wardx;
        this.source = source;
        var dims = Dims.Of("source", source);
        awarded = wardx.Counter("coins.awarded", dims);
        grants = wardx.Counter("coins.grants", dims);
        size = wardx.Histogram("coins.award_size", dims,
            new double[] { 10, 50, 100, 250, 500, 1000, 5000 });
    }

    public void RecordGrant(double amount, string grantId)
    {
        awarded.Add(amount);
        grants.Inc();
        size.Observe(amount, Dims.Of("grantId", grantId));
        var maxAward = wardx.Config.Get("economy.maxAward", 500.0);
        if (amount > maxAward)
        {
            var attrs = Dims.Of("source", source, "amount", amount, "grantId", grantId);
            wardx.Event("coins.anomaly", attrs);
            wardx.Log.Warn("coins_anomaly", attrs);
        }
    }
}
```

Create one `GrantTelemetry` per source during setup and keep it as a field.
Keep `source` to a small set such as match, daily, purchase, or admin. Compare
histogram maxima and `coins.awarded / coins.grants` with the configured bound
through MCP `get_aggregates`. Inspect the exemplar's `grantId` in the game
database and query `get_recent_logs` for `coins_anomaly`. Wardx's at-most-once
telemetry is not a wallet ledger or a per-player audit trail.

## Funnels

Wardx compares how often each named step fired. It does not reconstruct a per-user path.

Give each step its own name. Emit the event and increment a counter of the same name. Read the drop in `get_aggregates`. Event attrs do not split that count. `Experiment.Goal` is one conversion or one quantitative value, not an N-step funnel.

```csharp
wardx.Event("onboarding.start", Dims.Of("channel", channel));
var onboardingStart = wardx.Counter("onboarding.start", Dims.Of("channel", channel));
onboardingStart.Inc();

wardx.Event("onboarding.done");
var onboardingDone = wardx.Counter("onboarding.done");
onboardingDone.Inc();
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
var sessionTimeMs = wardx.Counter("session.time_ms");
sessionTimeMs.Add(durationMs);
var sessionEnded = wardx.Counter("session.ended");
sessionEnded.Inc();
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

### Resolution and goals

1. If the key is absent from the snapshot, return the fallback.
2. Without a subject, return the shared Remote Config value.
3. With a subject and an applicable experiment, return its variant value;
   otherwise return the shared value.

Sync responses supply snapshots. Reads continue using the last snapshot
between syncs. `Get<T>` infers its result type from the fallback and converts
the stored value to that type; incompatible conversions can throw.

Define experiment variants on the server over existing Remote Config keys.
The application continues reading those keys:

```csharp
var delayMs = wardx.Config.Get("message.delayMs", 1000, userId);
await System.Threading.Tasks.Task.Delay(delayMs);
await DeliverMessageAsync();
var messageSent = wardx.Counter("message.sent");
messageSent.Inc();
wardx.Experiment.Goal("message.sent", userId, value: 1);
```

`DeliverMessageAsync` is application code. Reading a variant can emit
`experiment.exposure` with the experiment, variant, and hashed subject. A goal
emits nothing until that subject has an exposure whose `goalMetric` matches
the goal name. A valid goal refers to exactly that assignment; calling without
a subject throws. Keep the experiment salt stable to preserve assignment.

## Experiment on level difficulty

Read difficulty from Remote Config and instrument the level's volume funnel:

```csharp
var enemyHp = wardx.Config.Get("level.3.enemyHp", 100, userId);
wardx.Event("level.start", Dims.Of("level", 3));
var levelStart = wardx.Counter("level.start", Dims.Of("level", 3));
levelStart.Inc();
```

On failure or completion, record `level.fail` or `level.complete` with the same
dimension. Compare those counts with starts through `get_aggregates`; they
count occurrences, not unique players. Use the session-duration example above
to record one quantitative `Experiment.Goal("session.duration", value: durationMs)`
at session end. If that is the experiment goal, do not emit level steps as goals.

Configure the experiment through server MCP `upsert_experiment`, using existing
keys, a hypothesis, `primaryMetric: "session.time_ms"`,
`goalMetric: "session.duration"`, `assignmentUnitKind: "session"`,
`outcomeKind: "mean"`, and the complete fixed-horizon policy. Use
`analyze_experiment` for the persisted decision and variant `goalMean`;
`ship_experiment` requires the current `expectedVersion` and a reason.
See the [server guide](../../packages/server/README.md) for experiment operations.

## Surface errors for investigation

Count failures and log a stable message with primitive attrs:

```csharp
var paymentError = wardx.Counter("payment.error", Dims.Of("code", "provider_timeout"));
paymentError.Inc();
wardx.Log.Error("payment_failed", Dims.Of("code", "provider_timeout"));
```

For an exception, send its type name and a sanitized, clipped stack string,
not the exception object. Keep each attr within the server's
`maxAttributeValueLength`; invalid attrs can cause the envelope to be rejected. Do not send credentials
or sensitive request data.

Query MCP `get_aggregates` for the failure rate and `get_recent_logs` with the
error level and message for recent evidence. A role's catalog `path` or `git`
provides the source location for an agent with access to that checkout. Wardx
does not edit source. The bounded recent-log ring is not a historical log store.

## Continue when the server is unavailable

Measurements continue in local memory. Failed batches are discarded and
`wardx.internal.frames_failed` increases. The next cycle sends new data;
there is no disk queue or replay of the failed frames. Remote Config reads
continue returning the last snapshot or the supplied fallback. Use a durable
system for events that must not be lost.

## Lifecycle

`FlushAsync` sends pending frames and leaves timers running. `ShutdownAsync` stops timers, sends pending frames, and closes the transport. In Unity, `OnApplicationQuit` stops timers without blocking the main thread on HTTP.

```csharp
await wardx.FlushAsync();
// At application shutdown:
await wardx.ShutdownAsync();
```

Concurrent `ShutdownAsync` callers receive the same task and await one final
flush and transport close. `Stop()` stops scheduling and closes the transport
without flushing. `Dispose()` waits for shutdown in .NET and calls `Stop()` in
Unity. Prefer awaiting shutdown at a controlled point before Unity quits;
quitting itself does not guarantee final delivery.

## Trace instrumentation locally

Set `Tracer = new ConsoleTracer()` in `WardxOptions` before creating the client.
It writes measurement, event, log, frame, and sync diagnostics to stderr. Pass
a `TextWriter` to select another output, or derive from `TracerBase` and
override the hooks you need. Unity can route a custom tracer to its own console.

Tracer callbacks run on the instrumentation path. Use them during development;
they are local diagnostics and do not go over the wire.

## API reference

| API | Purpose |
| --- | --- |
| `WardxClient.Create(options)` | Creates a client with automatic scheduling. |
| `Counter(name, dims)` | `Inc()` or `Add(n)` for window sums. |
| `Gauge(name, dims)` | `Set(value)` for the latest value. |
| `Histogram(name, dims, buckets)` | `Observe(value, attrs)` for distributions and an optional exemplar. |
| `Distinct(name, dims)` | `Add(identifier)` for approximate unique counts. |
| `Timer(name, dims)` | Returns a token with `Stop(endDims)` to record milliseconds. |
| `Event(name, attrs)` | Buffers a product event. |
| `Log.Debug/Info/Warn/Error(message, attrs)` | Buffers a structured log. |
| `Identify(subjectId)` | Sets the instance default subject; `null` clears it. |
| `Config.Get<T>(key, fallback, subjectId)` | Reads a local shared or variant value. |
| `Experiment.Goal(name, subjectId, value)` | Records a conversion or quantitative outcome for an exposed subject. |
| `RetentionActivity(userId)` | Records activity with an explicit stable identity. |
| `FlushAsync()` | Sends pending frames and keeps scheduling. |
| `ShutdownAsync()` | Stops scheduling, sends pending frames, and closes transport. |
| `Stop()` | Stops without a final flush. |

Optional dimensions, attrs, bucket arrays, and subject arguments can be omitted.
Examples use application-owned identifiers and functions where indicated.

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

## Optional enums

The main examples bind string names once and measure through typed handles.
Enums remain useful when the application shares names across several APIs;
they are not required to make measurement sites typed or avoid repeated strings.
If you choose enums, define them once. Each `WardxName` preserves the wire name.

```csharp
using Wardx;

enum Signal
{
    [WardxName("match.started")] MatchStarted,
    [WardxName("match.completed")] MatchCompleted,
    [WardxName("players.online")] PlayersOnline,
    [WardxName("request.duration")] RequestDuration,
    [WardxName("shot.traffic.hids")] TrafficIdentifiers,
    [WardxName("matchmaking.duration")] MatchmakingDuration,
    [WardxName("coins.awarded")] CoinsAwarded,
    [WardxName("matchmaking.queue_depth")] QueueDepth,
    [WardxName("http.duration_ms")] HttpDuration,
    [WardxName("http.payload_bytes")] HttpPayloadBytes,
    [WardxName("coins.award_size")] CoinAwardSize,
    [WardxName("purchase")] Purchase,
    [WardxName("purchase.count")] PurchaseCount,
    [WardxName("purchase.amount")] PurchaseAmount,
    [WardxName("coins.grants")] CoinGrants,
    [WardxName("coins.anomaly")] CoinAnomaly,
    [WardxName("onboarding.start")] OnboardingStart,
    [WardxName("onboarding.done")] OnboardingDone,
    [WardxName("session.duration")] SessionDuration,
    [WardxName("session.time_ms")] SessionTime,
    [WardxName("session.ended")] SessionEnded,
    [WardxName("message.sent")] MessageSent,
    [WardxName("level.start")] LevelStart,
    [WardxName("payment.error")] PaymentError
}

enum ConfigKey
{
    [WardxName("economy.maxAward")] MaxAward,
    [WardxName("level.3.enemyHp")] Level3EnemyHp,
    [WardxName("matchmaking.timeoutMs")] MatchmakingTimeout,
    [WardxName("message.delayMs")] MessageDelay
}

enum LogMessage
{
    [WardxName("match_started")] MatchStarted,
    [WardxName("coins_anomaly")] CoinAnomaly,
    [WardxName("payment_failed")] PaymentFailed
}

enum Dimension
{
    [WardxName("mode")] Mode,
    [WardxName("result")] Result,
    [WardxName("source")] Source,
    [WardxName("region")] Region,
    [WardxName("route")] Route,
    [WardxName("grantId")] GrantId,
    [WardxName("product")] Product,
    [WardxName("currency")] Currency,
    [WardxName("amount")] Amount,
    [WardxName("channel")] Channel,
    [WardxName("level")] Level,
    [WardxName("code")] Code
}

enum GameMode
{
    [WardxName("ranked")] Ranked,
    [WardxName("casual")] Casual
}

enum Result
{
    [WardxName("success")] Success,
    [WardxName("error")] Error,
    [WardxName("violating")] Violating
}

enum GrantSource
{
    [WardxName("match")] Match,
    [WardxName("daily")] Daily,
    [WardxName("purchase")] Purchase,
    [WardxName("admin")] Admin
}

enum Region
{
    [WardxName("south-america")] SouthAmerica
}

enum Route
{
    [WardxName("checkout")] Checkout
}

enum Product
{
    [WardxName("coins-small")] SmallCoins
}

enum Currency
{
    [WardxName("USD")] Usd
}

enum PaymentCode
{
    [WardxName("provider_timeout")] ProviderTimeout
}
```

For example, these calls contribute to the same metric series:

```csharp
var completed = wardx.Counter(Signal.MatchCompleted, Dims.Of(Dimension.Mode, GameMode.Ranked));
var sameSeries = wardx.Counter("match.completed", Dims.Of("mode", "ranked"));
completed.Inc();
sameSeries.Inc();
```

Without `WardxName`, a member such as `MatchCompleted` sends `"MatchCompleted"`
with its original case. Runtime data such as `userId`, `hid`, `grantId`, and
`channel` remains application data; connection options also remain strings.

`Dims.Of` accepts mixed string and enum keys in its one-, two-, and three-pair
forms. Its object-key overloads reject keys that are neither strings nor enums.
Enum values also work in ordinary `IReadOnlyDictionary<string, object>` inputs,
including event/log attrs, histogram exemplars, and timer end dimensions. The
SDK converts them to strings without changing the caller's dictionary; the
usual limits apply to the converted strings. For collection initializer keys,
use strings or build the dictionary with `Dims.Of`.

The same enum name overloads are available on `WardxCore` (`ConfigGet` and
`ExperimentGoal` there). `Config.Get` infers the return type from the fallback;
enums are supported as keys, not as Remote Config return types. Subject IDs,
distinct identifiers, and connection options keep their existing string APIs.

Undefined numeric enum values, ambiguous aliases sharing a numeric value, and
blank `WardxName` mappings throw. A flags combination is accepted only when it
has exactly one declared member. No casing or underscore-to-dot conversion is
implicit. Renaming an unmapped member changes its wire name; use a stable
`WardxName` mapping to preserve existing catalog names and history. Name lookup
is cached after the first reflection lookup for each enum value.
