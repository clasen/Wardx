---
name: wardx-csharp
description: Integrate or modify the Wardx C# SDK in non-Unity .NET applications using WardxClient. Use for telemetry, Remote Config, experiment assignment, and explicit user retention; use wardx-server for MCP or server operations.
---

# Wardx C# / .NET SDK

Use this skill for non-Unity C# integration and shared C# engine changes.
Read [references/package.md](references/package.md) for enum usage, package
internals, and verification. Use wardx-unity for Unity lifecycle and transport
and wardx-server for catalog, experiment definitions, and MCP operations.

## Integrate

Reference `clients/csharp/Runtime/Wardx.csproj` and use `using Wardx;`.
Create the client with `WardxClient.Create(options)`. The .NET runtime is selected
when `UNITY_5_3_OR_NEWER` is not defined.

When enabled, required `WardxOptions` fields: `Endpoint`, `ProjectKey`, `Project`, `Role`,
`AppVersion`, `Environment`, and `PrivacySalt`. Use the application's configuration;
do not invent deployment values or derive the privacy salt from the key.
`Project` must match the credential's server mapping. `Role` is an open name other
than `*`; the server authorizes it against the credential's allowed roles.
Keep `PrivacySalt` stable across clients in the same project. Operational defaults
live in `SdkDefaults`, aligned with `packages/core/defaults.json`.

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

Create this recorder once after creating the client and keep it as a service
field, one per supported mode. The recorder does not own client shutdown.

Measurements are synchronous memory updates, not Tasks or network calls.
Bootstrap sync starts immediately; later syncs use the configured interval and
jitter. Delivery is at-most-once: failed batches are discarded, without disk
queues or retries of the same frames. Use a different mechanism for lossless data.

## Reuse metric handles

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

`WardxClient.Create(new WardxOptions { Enabled = false })` returns an inert
client with usable handles, no engine/transport/scheduler, and immediate flush
and shutdown. It needs no connection options; config reads return the caller's
fallback. This mode is fixed at creation.

## Choose a signal

| Question | API |
| --- | --- |
| Count or amount | `Counter(name, dims).Inc()` / `.Add(n)` |
| Latest value | `Gauge(name, dims).Set(value)` |
| Distribution | `Histogram(name, dims, buckets).Observe(value, attrs)` |
| Approximate unique count | `Distinct(name, dims).Add(identifier)` |
| Elapsed time | `var timer = Timer(name, dims)`; then `timer.Stop(endDims)` |
| Discrete fact | `Event(name, attrs)` |
| Diagnostic detail | `Log.Error(message, attrs)` or another log level |
| Explicit user activity for retention | `RetentionActivity(userId)` |

Counters are window deltas; gauges are absent in windows without a `Set`.
Reuse handles in loops. Prefer counters for high-volume totals; add events/logs
when bounded detail is useful, not automatically for every count.

Use low-cardinality string, number, boolean, or enum dimension values via
`Dims.Of(...)`. Never use user IDs, emails, or unique transaction IDs as dimensions.
Count/length/series limits yield no-op series and increment cardinality drops;
invalid value types or enum values throw. Histogram bounds are fixed per series;
attrs retain only the window-max exemplar. Redact diagnostic attrs as needed.
Prefer `ICounter`, `IGauge`, `IHistogram`, and `IDistinct` fields initialized
in the owning component or service setup. Wire-name strings belong there;
measurement sites call the fields directly. Do not introduce enums solely to
avoid repeated metric strings. Enums remain optional for shared application
names; preserve existing enum integrations and wire names. Read the enum
reference before using mappings or overloads in a version-pinned consumer.

Distinct counts send salted HLL sketches, not identifiers. Volume funnels compare
separately named steps, not unique-user journeys; event attrs do not split
historical counts. SDK `sessionId` is envelope identity, not a session clock.
For duration use an application-owned monotonic clock. If heartbeats add elapsed
deltas to a time counter, add only the remaining delta at the end; observe the
full duration once in a histogram. Choose an experiment goal from the product
question rather than always using session duration.

## Remote Config and experiments

`Config.Get(key, fallback, subjectId)` reads the last local snapshot without
network I/O. Missing keys use the caller's fallback. Remote Config contains no
secrets; signal descriptions belong in the server catalog.

On a single-user instance, `Identify(userId)` sets the default experiment subject;
`Identify(null)` clears it. For multiple users, pass `subjectId` per call instead
of changing shared identity. Neither ordinary metrics nor base Remote Config
requires identification. Avoid a shared default subject on a multi-user backend.

```csharp
var delayMs = wardx.Config.Get("message.delayMs", 1000, userId);
// At the actual matching outcome, after exposure:
wardx.Experiment.Goal("message.sent", userId, 1);
```

Assignment is local and deterministic for the subject and experiment plan.
A matching config read can emit exposure. Without a subject, the read returns
base Remote Config without exposure. `Experiment.Goal` throws without a subject
and emits only for a matching `goalMetric` exposed in this instance. The SDK
hashes the subject; do not add the raw ID to dimensions or attrs. Do not define
experiments or persist chosen variants in application code. After a shipped
experiment's disabled state reaches the snapshot, no new exposure is expected.

## Retention

Call `RetentionActivity(userId)` on the activity that defines a return. It requires
an explicit nonblank stable ID; `Identify` does not supply it. Use a consistent
activity definition and stable project salt across devices. The server stores
UTC cohorts and received-user returns on D1/D7/D30. Lost batches can bias counts;
delayed activity can revise cohorts. Query semantics belong to the server skill.

## Lifecycle and diagnosis

Integrate `await ShutdownAsync()` with the application's existing asynchronous
shutdown lifecycle. It stops scheduling, waits for the current sync, attempts a
final flush, and closes transport; repeated calls are safe. `FlushAsync()` sends
now without stopping scheduling. `Stop()` closes without a final flush.
Do not replace the host's shutdown policy with a blocking process-exit callback.

Use `ConsoleTracer` for local diagnosis, or implement `ITracer` / subclass
`TracerBase`; hooks are `Measure`, `Event`, `Log`, `Frame`, and `Sync`. Tracing is
not sent to the server; do not expose secrets through it.
For missing data, inspect failed/dropped frame counters, endpoint, credentials,
role, and capacity. For config fallbacks, check snapshot delivery and visibility.
Preserve synchronous measurement and at-most-once delivery when modifying the SDK.
