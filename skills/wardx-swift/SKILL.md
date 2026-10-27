---
name: wardx-swift
description: Integrate or modify the Wardx Swift SDK in macOS and iOS applications using WardxClient. Use for telemetry, Remote Config, experiment assignment, and explicit user retention from Swift; use wardx-server for MCP or server operations.
---

# Wardx Swift SDK (macOS / iOS)

Use this skill for Swift integration in macOS and iOS apps and for changes to
`clients/swift`. Read [references/package.md](references/package.md) for
package internals, contracts, and verification. Use wardx-server for catalog,
experiment definitions, and MCP operations.

## Integrate

Add the package `https://github.com/clasen/Wardx.git` (the manifest sits at the
repository root) and depend on the `Wardx` product. Use `import Wardx` and
create the client with `try WardxClient.create(options)`. Requires macOS 12 or
iOS 15 and a Swift 6 toolchain.

When enabled, required `WardxOptions` fields: `endpoint`, `projectKey`, `project`, `role`,
`appVersion`, `environment`, and `privacySalt`. Use the application's configuration;
do not invent deployment values or derive the privacy salt from the key.
`project` must match the credential's server mapping. `role` is an open name other
than `*`, such as `desktop` or `ios`; the server authorizes it against the
credential's allowed roles. Keep `privacySalt` stable across clients in the same
project. Operational defaults live in `SdkDefaults`, aligned with
`packages/core/defaults.json`. Invalid options make `create` throw `WardxError`.

```swift
import Wardx

final class ExportTelemetry {
    private let completed: any Counter
    private let duration: any Histogram

    init(_ wardx: WardxClient, format: String) {
        completed = wardx.counter("export.completed", ["format": .string(format)])
        duration = wardx.histogram("export.duration_ms", ["format": .string(format)],
            buckets: [100, 500, 2000, 10000, 60000])
    }

    func recordCompleted(durationMs: Double) {
        completed.inc()
        duration.observe(durationMs)
    }
}
```

Create this recorder once after creating the client and keep it as a property,
one per supported format. The recorder does not own client shutdown. Keep one
client per process, typically owned by the app delegate or an app-level service.

Measurements are synchronous memory updates, not `async` calls or network I/O.
Handles are `Sendable` and safe from any thread or actor. Bootstrap sync starts
immediately; later syncs use the configured interval and jitter. Delivery is
at-most-once: failed batches are discarded, without disk queues or retries of the
same frames. Use a different mechanism for lossless data.

## Reuse metric handles

Create metric handles once per client and stable name/dimension combination,
then reuse them in handlers, callbacks, and loops. This avoids repeated dimension
validation, series-key construction, and registry lookup. Normal aggregation
windows and flushes reset values, not handles. Rebind when replacing the client.

For varying dimensions, bind one recorder per application-owned, bounded value
set (mode, region, source). Never build an unbounded handle cache keyed by user
IDs or arbitrary input. Keep histogram buckets fixed. Timer tokens measure one
operation: create a fresh token for each operation, not one token for the client.
For a hot duration path, reuse a histogram and observe an application-measured
elapsed duration instead. Events, logs, retention, and experiment goals remain
per-occurrence calls.

`WardxClient.create(WardxOptions(enabled: false))` returns an inert client with
usable handles, no engine/transport/scheduler, and immediate flush and shutdown.
It needs no connection options; config reads return the caller's fallback. This
mode is fixed at creation.

## Choose a signal

| Question | API |
| --- | --- |
| Count or amount | `counter(name, dims).inc()` / `.add(n)` |
| Latest value | `gauge(name, dims).set(value)` |
| Distribution | `histogram(name, dims, buckets:).observe(value, attrs:)` |
| Approximate unique count | `distinct(name, dims).add(identifier)` |
| Count that must survive offline time and restarts | `retainedCounter(name, dims)` / `retainedDistinct(name, dims)` |
| Elapsed time | `let timer = timer(name, dims)`; then `timer.stop(endDims)` |
| Discrete fact | `event(name, attrs)` |
| Diagnostic detail | `log.error(message, attrs)` or another log level |
| Explicit user activity for retention | `retentionActivity(userId)` |
| Acquisition channel of that user | `retentionActivity(userId, channel: channel)` |
| User reached a goal (cohort conversion) | `conversion(userId, goal: goal)` |

Counters are window deltas; gauges are absent in windows without a `set`.
Prefer counters for high-volume totals; add events/logs when bounded detail is
useful, not automatically for every count.

`Dims` is `[String: WardxValue]`: string, number, and boolean literals work
directly; wrap variables with `.string(x)`, `WardxValue(n)`, or `.bool(b)`.
Use low-cardinality values. Never use user IDs, emails, or unique transaction
IDs as dimensions. Count/length/series limits yield no-op series and increment
cardinality drops. Histogram bounds are fixed per series; attrs retain only the
window-max exemplar. Redact diagnostic attrs as needed.

Keep wire-name strings in the recorder initializer; measurement sites call the
stored handles. Swift has no enum overloads: if the app already keeps names in a
`String` enum, pass `.rawValue`. Do not introduce enums solely to avoid repeated
metric strings.

Distinct counts send salted HLL sketches, not identifiers. Volume funnels compare
separately named steps, not unique-user journeys; event attrs do not split
historical counts. SDK `sessionId` is envelope identity, not a session clock.
For duration use an application-owned monotonic clock. Choose an experiment goal
from the product question rather than always using session duration.

Measurement calls never throw. Programmer errors (empty names, non-finite values,
invalid retention labels, a goal without a subject, changed histogram buckets)
trigger an assertion in debug builds and are dropped in release builds. Fix them
when a debug run stops; do not wrap calls in `do`/`catch`.

## Remote Config and experiments

`config.get(key, fallback, subjectId:)` reads the last local snapshot without
network I/O. The fallback fixes the result type: `String`, `Bool`, `Int`,
`Double`, or `JSONValue` for objects and arrays. Missing keys and values of
another type return the fallback. Remote Config contains no secrets; signal
descriptions belong in the server catalog.

Role controls which keys and experiments this instance receives. Server-side
conditions resolve visible base values; an applicable A/B variant overrides
that base. Knobs are the adjustable config keys.

Use `options.attributes` or `wardx.setAttributes(map)` with a flat `Dims` of
strings, finite numbers, or booleans. The setter replaces the map and an empty
map clears it. These attributes belong to the instance, not the experiment
subject. Keep build and channel separate from role; `platform` is `swift` and
the SDK sends the operating system family as `os` (`macos` or `ios`).

`identify(userId)` sets the default experiment subject; `identify(nil)` clears
it. A desktop or mobile app normally serves one user, so identify after sign-in.
Neither ordinary metrics nor base Remote Config requires identification.

```swift
let delayMs = wardx.config.get("message.delayMs", 1000, subjectId: userId)
// At the actual matching outcome, after exposure:
wardx.experiment.goal("message.sent", subjectId: userId, value: 1)
```

Assignment is local and deterministic for the subject and experiment plan.
A matching config read can emit exposure. Without a subject, the read returns
base Remote Config without exposure. `experiment.goal` needs a subject and emits
only for a matching `goalMetric` exposed in this instance. The SDK hashes the
subject; do not add the raw ID to dimensions or attrs. Do not define experiments
or persist chosen variants in application code.

## Retention

Call `retentionActivity(userId)` on the activity that defines a return. It
requires an explicit nonblank stable ID; `identify` does not supply it. Use a
consistent activity definition and stable project salt across devices and
platforms. The server stores UTC cohorts and received-user returns on D1/D7/D30.
Lost batches can bias counts; delayed activity can revise cohorts.

Pass `retentionActivity(userId, channel:)` where the acquisition channel is known;
the earliest channel-bearing activity fixes it. Call `conversion(userId, goal:)`
where the goal happens. Channels and goals are lowercase low-cardinality labels
(`^[a-z0-9][a-z0-9._-]{0,63}$`). A conversion is not a return.

## Lifecycle and diagnosis

`create(_:)` observes the app lifecycle: macOS sleep and iOS backgrounding cut the
frame window and flush, wake and foreground resume, and termination stops without
a final flush. When the last window matters on macOS, await `shutdown()` from
`applicationShouldTerminate(_:)` and reply later. `flush()` sends now without
stopping scheduling. `shutdown()` stops scheduling, waits for the current sync,
attempts a final flush, and closes transport; repeated calls share it. `stop()`
saves retained values and closes without a final flush.

Retained metrics are stored under Application Support by default, or at
`options.retainedPath`; the file is written only after a retained metric is used.

Use `ConsoleTracer()` for local diagnosis, or implement `WardxTracer`; hooks are
`measure`, `event`, `log`, `frame`, and `sync`, all with empty defaults. Tracing
is not sent to the server; do not expose secrets through it. For missing data,
inspect failed/dropped frame counters, endpoint, credentials, role, App Transport
Security for plain `http` endpoints, and the macOS sandbox's outgoing network
entitlement. For config fallbacks, check snapshot delivery and visibility.
