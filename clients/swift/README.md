# Wardx for Swift (macOS / iOS)

Swift SDK for Wardx. It implements Protocol v1 over `POST /v1/sync`, JSON + gzip, and header `X-Wardx-Key`, and sends `sdk.name = wardx-swift`, `client.platform = swift`, and `client.os = macos` or `ios`. Treat Swift behavior as equivalent to Node and C# only where shared fixtures or the real HTTP interoperability test prove it.

This SDK talks to that server. See [Wardx](https://github.com/clasen/Wardx). Architecture: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

A measure call changes local memory only. Delivery is at-most-once. A failed sync discards that batch. Remote Config is a local read of the last snapshot. Frames are split to `maxFrameBytes` and `maxEnvelopeItems` rows with consecutive sequence numbers, and a sync sends them in as many requests as needed to stay within `maxEnvelopeItems` rows and `maxEnvelopeBytes` uncompressed bytes. If a request fails, the rest of that sync is discarded and counted in `wardx.internal.frames_failed`.

**WARNING:** Apart from retained metrics, the SDK does not write a disk queue or retry the same frames.

macOS 12 or iOS 15 and later, Swift 6 toolchain (Xcode 16 or later). No third-party dependencies.

## Install

**Xcode.** File → Add Package Dependencies → `https://github.com/clasen/Wardx.git`, then add the `Wardx` library to your app target.

**Package.swift.**

```swift
.package(url: "https://github.com/clasen/Wardx.git", branch: "main")
```

```swift
.target(name: "MyApp", dependencies: [.product(name: "Wardx", package: "Wardx")])
```

The manifest lives at the repository root and builds only `clients/swift`; repository tags are shared with the C# / Unity package.

> [!NOTE]
> **Agent skill.** Teach the agent this SDK with the [Skills CLI](https://skills.sh):
>
> ```bash
> npx skills add https://github.com/clasen/Wardx --skill wardx-swift
> ```

## Start

| Required option | Meaning |
| --- | --- |
| `endpoint` | Ingest base URL, for example `http://127.0.0.1:8787`. |
| `projectKey` | Project credential sent as `X-Wardx-Key`. |
| `project` | Project name matching the server mapping. |
| `role` | Routing name such as `desktop` or `ios`. Cannot be `*`. |
| `appVersion` | Application version. |
| `environment` | Environment name. |
| `privacySalt` | Stable, project-specific salt for one-way subject hashes. Never derived from `projectKey`. |

The project key authenticates only the project; the role is routing metadata, not authorization. Never put secrets in Remote Config.

```swift
import Wardx

let wardx = try WardxClient.create(WardxOptions(
    endpoint: "http://127.0.0.1:8787",
    projectKey: "dev_project_key",
    project: "demo",
    role: "desktop",
    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
    environment: "production",
    privacySalt: "demo-subject-hash-v1"
))

wardx.log.info("document_opened", ["kind": "markdown"])
wardx.event("export.started", ["format": "pdf"])
let exports = wardx.counter("export.completed", ["format": "pdf"])
exports.inc()
wardx.gauge("documents.open").set(3)
wardx.histogram("render.duration").observe(42)
wardx.distinct("active.devices").add(deviceId)

let timer = wardx.timer("sync.duration")
timer.stop(["result": "success"])

await wardx.flush()
await wardx.shutdown()
```

`WardxOptions` also takes `attributes`, `tracer`, `retainedPath`, and optional overrides for every value in [`SdkDefaults`](Sources/Wardx/Settings.swift), which match `packages/core/defaults.json`. Invalid options make `create` throw `WardxError`.

`create(_:)` starts a bootstrap sync immediately, then syncs every `syncIntervalMs` (15 s) with a jitter factor from 0.85 to 1.15. `create(_:transport:)` takes a custom `SyncTransport` and attaches no scheduler; its caller drives `flush()` and `shutdown()`. Each client creates its own `instanceId` and `sessionId`.

`Dims` is `[String: WardxValue]`: string, finite number, or boolean literals work directly. Use `WardxValue(count)` or `.string(name)` for variables.

## Disable the SDK

```swift
let wardx = try WardxClient.create(WardxOptions(enabled: false))
```

When disabled, no other option is required. Handles, timers, events, logs, identity, retention, and goals do nothing; `config.get` returns the fallback; `flush()` and `shutdown()` return immediately.

## Signals

| Need | Call |
| --- | --- |
| How many / how much | `counter(name, dims).inc()` or `.add(n)` |
| Last known size | `gauge(name, dims).set(value)` |
| Distribution | `histogram(name, dims, buckets:).observe(value, attrs:)` |
| Approximate unique count | `distinct(name, dims).add(identifier)` |
| Count that must survive offline time and restarts | `retainedCounter(name, dims)` or `retainedDistinct(name, dims)` |
| Elapsed time | `timer(name, dims)` then `stop(endDims)` |
| Discrete product fact | `event(name, attrs)` |
| Failure | `log.error(message, attrs)` with a clipped `stack` or provider `code` |
| Remote value / variant | `config.get(key, fallback)` after `identify(userId)`, or `config.get(key, fallback, subjectId:)` |
| Experiment conversion | `experiment.goal(name)` after `identify`, or `experiment.goal(name, subjectId:, value:)` |
| User retention | `retentionActivity(userId, channel:)` and `conversion(userId, goal:)` |

A counter in a frame is a window delta. Do not put a user id on a metric dimension. `distinct` hashes each identifier locally with `privacySalt` into a HyperLogLog (`p=9`, about 4.6% standard error); only the sketch goes over the wire.

The recipes in the [C# / Unity guide](../csharp/README.md) (funnels, session duration, level-difficulty experiments, currency grants, error investigation) apply unchanged with the Swift names above.

## Keep handles as properties

Create handles once per client and stable dimension set, then reuse them. This avoids repeated validation and registry lookups. Never build an unbounded handle cache keyed by user IDs.

```swift
final class ExportTelemetry {
    private let completed: any Counter
    private let duration: any Histogram

    init(_ wardx: WardxClient, format: String) {
        completed = wardx.counter("export.completed", ["format": .string(format)])
        duration = wardx.histogram("export.duration_ms", ["format": .string(format)], buckets: [100, 500, 2000, 10000])
    }

    func recordCompleted(durationMs: Double) {
        completed.inc()
        duration.observe(durationMs)
    }
}
```

Handles are `Sendable` and safe to use from any thread or actor. Swift has no enum overloads; pass `MyMetric.exports.rawValue` if you keep names in a `String` enum.

## Count while offline

`retainedCounter` and `retainedDistinct` keep their values in a file until a sync is acknowledged, so they survive offline time and restarts. Delivery is at-least-once, values are reported in the window of the sync that delivers them, and a permanent rejection (400, 413, 415) drops them. `maxRetainedSeries` (default 64) caps the retained series.

`create(_:)` stores the file at `Application Support/<bundle identifier>/wardx-retained-<project>-<role>.json` unless `retainedPath` is set. The file is written only once a retained metric is used. With `create(_:transport:)`, set `retainedPath` to use retained metrics.

## Remote Config and experiments

`identify(userId)` sets the default subject; a per-call `subjectId` overrides it and `identify(nil)` clears it. Use a stable account id, not the SDK `sessionId`.

```swift
wardx.identify(userId)
let timeoutMs = wardx.config.get("matchmaking.timeoutMs", 5000)
let title = wardx.config.get("onboarding.title", "Welcome")
let layout = wardx.config.get("home.layout", JSONValue.null)
wardx.experiment.goal("message.sent", value: 1)
```

`get` infers its type from the fallback: `String`, `Bool`, `Int`, `Double`, or `JSONValue` for objects and arrays. It returns the fallback until a sync applies a snapshot, when the key is absent, or when the stored value has another type (for example `2.5` read as `Int`). Assignment is local and deterministic; exposure is an `experiment.exposure` event with a hashed subject. A goal emits nothing until that subject has an exposure whose `goalMetric` matches.

`attributes` and `setAttributes(_:)` send flat instance attributes for conditional Remote Config. `setAttributes` replaces the map; the next sync resolves it, and `await wardx.flush()` requests one now.

## User retention

```swift
wardx.retentionActivity(userId, channel: "tiktok")
wardx.conversion(userId, goal: "purchase")
```

Only salted hashes are sent. Channels and goals match `^[a-z0-9][a-z0-9._-]{0,63}$`. Read results through MCP `get_retention`. See the [C# guide](../csharp/README.md#user-retention) for cohort semantics.

## Programmer errors

Measurement calls never throw. An invalid call (empty name, non-finite value, invalid label, a goal without a subject) stops debug builds with an assertion and is dropped in release builds, so instrumentation cannot take down the app. Dimension sets over `maxDimensionKeys`, `maxDimensionValueLength`, or `maxSeriesPerMetric` return a no-op handle and increment `wardx.internal.cardinality_dropped`.

## Lifecycle

| Event | macOS | iOS |
| --- | --- | --- |
| Cut the window and flush | system sleep | app enters background (inside a background task) |
| Resume | wake | app returns to foreground |
| Stop without a final flush | app terminates | app terminates |

`flush()` sends pending frames and keeps scheduling. `shutdown()` stops scheduling, sends pending frames, and closes the transport; concurrent callers await the same shutdown. `stop()` saves retained values and stops without flushing. Termination does not guarantee final delivery: on macOS, await `shutdown()` from `applicationShouldTerminate(_:)` if the last window matters.

## Trace instrumentation locally

Set `options.tracer = ConsoleTracer()` to print measurement, event, log, frame, and sync diagnostics to stderr, or pass `ConsoleTracer(write:)` to route lines elsewhere. Implement `WardxTracer` for custom hooks; every method has an empty default. Callbacks run on the instrumentation path and can run on background threads.

## API reference

| API | Purpose |
| --- | --- |
| `WardxClient.create(options)` | Creates a client with automatic scheduling and lifecycle handling. |
| `WardxClient.create(options, transport:)` | Creates a client over a custom transport, without scheduling. |
| `counter` / `gauge` / `histogram` / `distinct` | Metric handles. |
| `retainedCounter` / `retainedDistinct` | Handles persisted until delivered. |
| `timer(name, dims)` | Returns a token whose first `stop(endDims)` records milliseconds. |
| `event(name, attrs)` | Buffers a product event. |
| `log.debug/info/warn/error(message, attrs)` | Buffers a structured log. |
| `identify(subjectId)` | Sets the default subject; `nil` clears it. |
| `config.get(key, fallback, subjectId:)` | Reads a local shared or variant value. |
| `experiment.goal(name, subjectId:, value:)` | Records a conversion or outcome for an exposed subject. |
| `retentionActivity(userId, channel:)` / `conversion(userId, goal:)` | Records retention activity and goals. |
| `setAttributes(attributes)` | Replaces the instance attributes. |
| `flush()` / `shutdown()` / `stop()` | Lifecycle. |

## Protocol

See [docs/PROTOCOL.md](../../docs/PROTOCOL.md). `maxEnvelopeItems` (10000) and `maxEnvelopeBytes` (2097152) match the server's `maxItemsPerEnvelope` and `maxRequestBytes` and must be lowered with them.

Verify the Swift suite and real CLI interoperability from the repository root:

```bash
pnpm run test:swift
```
