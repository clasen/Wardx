# clients/csharp internals

Use this file when changing `clients/csharp`. Application instrumentation stays in [SKILL.md](../SKILL.md).

## Layout

| Path | Role |
| --- | --- |
| `Runtime/package.json` | UPM package `com.wardx.sdk`. Unity 2021.3+. |
| `Runtime/Wardx.csproj` | .NET Standard 2.1 entry. Compiles Client + Dotnet + Unity. |
| `Runtime/Wardx.asmdef` | Unity assembly. References `Wardx.Core`. |
| `Runtime/Client/WardxClient.cs` | `WardxClient.Create`, measure API, envelope, gzip, apply config. |
| `Runtime/Client/Gzip.cs` | gzip compress / decompress. |
| `Runtime/Client/ISyncTransport.cs` | `PostAsync` / `Close`. |
| `Runtime/Client/ConsoleTracer.cs` | stdout tracer. |
| `Runtime/Dotnet/HttpClientTransport.cs` | `#if !UNITY`. `HttpClient` + timer bootstrap. `sdk.name = wardx-csharp`. |
| `Runtime/Unity/UnityRuntime.cs` | `#if UNITY`. `UnityWebRequestTransport`, `WardxHost`, `WardxBehaviour`. `sdk.name = wardx-unity`. |
| `Runtime/Core/` | Engine: settings, metrics, buffers, config, frames, hashes. `Wardx.Core.csproj` / `Wardx.Core.asmdef`. |
| `Tests/Wardx.Tests.csproj` | `dotnet run` test host (`npm run test:csharp`). |

Exports: `WardxClient`, `WardxOptions`, `WardxBehaviour` (Unity), `Dims`, `ConsoleTracer`. Namespace `Wardx`.

`WardxClient.Create(options)` is `UnityBootstrap.Start` or `DotnetBootstrap.Start` after `Settings.Resolve`.

## Contracts not to break

- Measure path is synchronous and allocation-light. No `await` inside `Inc` / `Set` / `Observe` / `Event` / `Log.*` / `Config.Get`.
- Failed sync increments `FramesFailed` and drops that envelope. Do not retry the same frames. Do not write a disk queue.
- `Role` cannot be `*`. Required create keys are `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`. Do not default them in code. `WardxBehaviour` may fill empty `AppVersion` from `Application.version` only.
- Histogram buckets are immutable per series. Changing them throws.
- Invalid or over-cap dimensions return no-op series and increment `CardinalityDropped`. Do not throw on cardinality.
- `Config.Get` never blocks on network. Missing key → caller fallback.
- `Identify(subjectId)` sets the instance default subject. `Identify(null)` clears it. Empty string throws. Per-call `subjectId` overrides it. A `game-server` that serves many users must pass `subjectId` per call and must not `Identify()`.
- `Experiment.Goal` throws without a subject (`Identify` or `subjectId`). Exposure payload hashes the subject (`PrivacySalt` or `ProjectKey`). Raw `subjectId` does not go on the wire. Same `subjectId` + experiment `id` + `salt` → same variant; do not persist the group.
- Tracer is duck-typed and optional. Hooks: `measure`, `event`, `log`, `frame`, `sync`. Tracer must not change frames, delivery, or config.
- Envelope `sdk.name` is `wardx-unity` under `#if UNITY`, else `wardx-csharp`. `client.platform` matches. `instanceId` / `sessionId` are one ULID each per process.
- Sync delay is `SyncIntervalMs * random(SyncJitterMin, SyncJitterMax)`, recomputed every cycle.
- `FlushAsync` snapshots if dirty and sends; it does not stop timers. `ShutdownAsync` stops timers, flushes, closes the transport, and is idempotent. Unity `Stop()` / `OnApplicationQuit` must not block the main thread on HTTP.

## Settings

`Settings.Resolve` merges `SdkDefaults` under caller options, then validates. `SdkDefaults` must stay aligned with `packages/core/defaults.json`.

Required from caller: `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`.

Required from defaults (override allowed): `AggregateIntervalMs` (1000), `SyncIntervalMs` (15000), `SyncJitterMin` (0.85), `SyncJitterMax` (1.15), `MaxBufferedEvents` (5000), `MaxBufferedLogs` (2000), `MaxFrameBytes` (524288), `MaxSeriesPerMetric` (1000), `MaxDimensionKeys` (8), `MaxDimensionValueLength` (64), `HttpTimeoutMs` (10000), `HistogramBuckets` (`[10, 25, 50, 100, 250, 500, 1000]`).

`Tracer` is not a default key. `PrivacySalt` empty → `ProjectKey`.

## Verify

```bash
npm run test:csharp
```

Prefer a real ingest server for sync assertions. Do not mock `WardxCore` inside client tests unless the change is transport-only.
