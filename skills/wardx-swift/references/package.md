# clients/swift internals

Use this file when changing `clients/swift`. Application instrumentation stays in [SKILL.md](../SKILL.md).

## Layout

| Path | Role |
| --- | --- |
| `Package.swift` (repository root) | SwiftPM manifest. Product `Wardx`; targets point into `clients/swift`. macOS 12+, iOS 15+. |
| `Sources/Wardx/WardxClient.swift` | `WardxClient.create`, measure API, locks, sync/snapshot queues, envelope, apply config, scheduler. |
| `Sources/Wardx/WardxCore.swift` | Unsynchronized engine: series, buffers, config, experiments, frame capture, retained flights. |
| `Sources/Wardx/Settings.swift` | `SdkDefaults`, `WardxOptions`, `Settings.resolve`, `WardxError`, clocks, wire constants. |
| `Sources/Wardx/Value.swift` | `WardxValue`, `Dims`, `JSONValue`, JSON writer/parser, `ConfigValue`. |
| `Sources/Wardx/Metrics.swift`, `Registry.swift` | Series, HLL, buffers, registry, misuse reporting. |
| `Sources/Wardx/Frame.swift` | Frame wire shape, internal metrics, splitter. |
| `Sources/Wardx/Hash.swift` | FNV-1a 32, xxHash64 subject hashes, ULIDs. |
| `Sources/Wardx/Config.swift` | Experiment assignment, resolver, config store. |
| `Sources/Wardx/RetainedMetrics.swift` | Disk-backed retained counters and distincts. |
| `Sources/Wardx/Transport.swift` | `SyncTransport`, `URLSessionTransport`, gzip over the Compression framework. |
| `Sources/Wardx/Platform.swift` | SDK identity, `os` detection, RSS, retained default path, lifecycle observers. |
| `Sources/Wardx/Tracer.swift` | `WardxTracer`, records, `ConsoleTracer`, traced wrappers. |
| `Sources/WardxInterop/main.swift` | Executable driven by `packages/server/test/swift-interop.mjs`. |
| `Tests/WardxTests/` | Swift Testing suite (`swift test`). |

Public API: `WardxClient`, `WardxOptions`, `WardxError`, `SdkDefaults`, `Dims`, `WardxValue`, `JSONValue`, `ConfigValue`, the `Counter` / `Gauge` / `Histogram` / `Distinct` handle protocols, `TimerToken`, `WardxLog`, `WardxConfig`, `WardxExperiment`, `SyncTransport`, `SyncResult`, `URLSessionTransport`, `WardxTracer` with its records, and `ConsoleTracer`.

The C# runtime in `clients/csharp` is the reference port; keep behavior aligned
with it unless a Swift idiom requires otherwise.

## Contracts not to break

- Measure path is synchronous: `inc` / `set` / `observe` / `event` / `log.*` / `config.get` take the client lock briefly and never await or touch the network.
- Failed sync increments `framesFailed` and drops that envelope. Do not retry the same frames. Do not write a disk queue for regular telemetry.
- `role` cannot be `*`. It is client-selected routing metadata, not authorization; Remote Config never contains secrets. Required create keys are `endpoint`, `projectKey`, `project`, `role`, `appVersion`, `environment`, `privacySalt`. Do not default them in code.
- Public measure APIs never throw. The core throws `WardxError`; the client reports it through `Misuse` (assertion in debug, dropped in release). Tests replace the handler with `Misuse.replaceHandler`. `create` and option validation do throw.
- Histogram buckets are immutable per series. Changing them is misuse.
- Distinct identifiers are salted and hashed locally with xxHash64; frames contain only the fixed `p=9` HLL sketch.
- Dimension count/length limits and series caps return no-op series and increment `cardinalityDropped`; do not turn them into misuse.
- `config.get` never blocks on network. Missing key or a value that `ConfigValue` cannot convert → caller fallback.
- `identify(nil)` clears the default subject; an empty string is misuse. Per-call `subjectId` overrides it.
- `experiment.goal` without a subject is misuse. Exposure payload hashes the subject with `privacySalt`. Same `subjectId` + experiment `id` + `salt` → same variant (FNV-1a 32 over UTF-8).
- `conversion(userId, goal:)` is cohort conversion for `get_retention`, unrelated to experiments.
- Tracer is optional; it must not change frames, delivery, or config.
- Envelope `sdk.name` is `wardx-swift`, `client.platform` is `swift`, `client.os` is `macos` or `ios` (Mac Catalyst reports `macos`). Every client owns one ULID `instanceId` and one ULID `sessionId`.
- No frame is captured until a response supplies `serverTime`; frame timestamps are shifted by the measured offset. A successful response without `serverTime` fails the sync.
- Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`, recomputed every cycle. Each sync, including encoding and the HTTP request, is bounded by `httpTimeoutMs`; a transport that ignores cancellation is abandoned.
- Snapshot and sync queues each allow one active job and one coalesced pending request. Lock order is `lifecycleGate` → `queueGate`; `gate` (core state) is never held while taking either of them.
- Retained frames travel after regular frames in their own envelopes; 400, 413, and 415 drop the flight, other failures restore it. The file format matches the C# SDK (`version: 1`, `pending`, `flight`).
- `flush()` snapshots and syncs even with no frames. `shutdown()` settles the active sync, attempts a final flush, and closes transport once. `stop()` closes without a final flush. Lifecycle observers call `suspend`/`resume`/`stop` and never block the main thread on HTTP.

## Settings

`Settings.resolve` merges `SdkDefaults` under caller options, then validates.
`SdkDefaults` must stay aligned with `packages/core/defaults.json`; a test
compares them. `maxRetainedSeries` is shared with C# only.

## Verify

```bash
pnpm run test:swift
```

It runs `swift test` and the real CLI interoperability test. For iOS-only code,
also build for a device:

```bash
xcodebuild -scheme Wardx -destination 'generic/platform=iOS' build
```

For documentation-only work, validate links and API claims without running the
suites. These checks do not exercise lifecycle notifications in a running app.
