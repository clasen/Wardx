---
name: wardx-unity
description: Integrate or modify Wardx in Unity players using com.wardx.sdk, WardxClient, or WardxBehaviour. Use for telemetry, Remote Config, experiment assignment, and explicit user retention; use wardx-server for MCP or server operations.
---

# Wardx Unity SDK

Use this skill for Unity-specific integration and runtime changes.
Read [references/package.md](references/package.md) for enum usage, package
internals, and verification. Use wardx-csharp for non-Unity applications
and wardx-server for catalog, experiment definitions, and MCP operations.

## Integrate

Install `com.wardx.sdk` from the intended Git revision or disk. Create the client
on the Unity main thread, or use `WardxBehaviour`. Its empty `AppVersion` uses
`Application.version`; supply all other required fields, including `PrivacySalt`.
Unity runtime code is selected by `UNITY_5_3_OR_NEWER`.

Required `WardxOptions` fields: `Endpoint`, `ProjectKey`, `Project`, `Role`,
`AppVersion`, `Environment`, and `PrivacySalt`. Use the application's configuration;
do not invent deployment values or derive the privacy salt from the key.
`Project` must match the credential's server mapping. `Role` is an open name other
than `*`; the server authorizes it against the credential's allowed roles.
Keep `PrivacySalt` stable across clients in the same project. Operational defaults
live in `SdkDefaults`, aligned with `packages/core/defaults.json`.

```csharp
using Wardx;

var wardx = WardxClient.Create(telemetryOptions);
var completed = wardx.Counter("match.completed", Dims.Of("mode", "ranked"));
completed.Inc();
```

Measurements are synchronous memory updates, not Tasks or network calls.
Bootstrap sync starts immediately; later syncs use the configured interval and
jitter. Delivery is at-most-once: failed batches are discarded, without disk
queues or retries of the same frames. Use a different mechanism for lossless data.

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
Enums are optional; preserve existing string calls and wire names. Read the enum
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
requires identification. Do not assume every Unity process has only one user.

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

`FlushAsync()` sends pending frames without stopping scheduling.
`ShutdownAsync()` stops scheduling, waits for the current sync, attempts a final
flush, and closes transport. Await it while the Unity player loop is still alive
when the application requires a final send attempt.

`Stop()` stops scheduling and cancels/closes transport without a final flush.
Unity quit/destroy callbacks use this nonblocking path; it does not guarantee
last-frame delivery. Never block the main thread with `.Wait()` or `.Result`
on HTTP. Keep one intended persistent client across scenes; do not accidentally
create a second client through both `WardxBehaviour` and manual startup.

Use `ConsoleTracer` for local diagnosis, or implement `ITracer` / subclass
`TracerBase`; hooks are `Measure`, `Event`, `Log`, `Frame`, and `Sync`. Tracing is
not sent to the server; do not expose secrets through it.
For missing data, inspect failed/dropped frame counters, endpoint, credentials,
role, and capacity. For config fallbacks, check snapshot delivery and visibility.
Preserve synchronous measurement and at-most-once delivery when modifying the SDK.
