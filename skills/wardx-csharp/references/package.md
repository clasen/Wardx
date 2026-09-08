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
| `Runtime/Dotnet/HttpClientTransport.cs` | `#if !UNITY_5_3_OR_NEWER`. `HttpClient` + timer bootstrap. `sdk.name = wardx-csharp`. |
| `Runtime/Unity/UnityRuntime.cs` | `#if UNITY_5_3_OR_NEWER`. `UnityWebRequestTransport`, `WardxHost`, `WardxBehaviour`. `sdk.name = wardx-unity`. |
| `Runtime/Core/WardxNameAttribute.cs` | Optional enum wire-name attribute and cached `EnumNames` resolution. |
| `Runtime/Core/` | Engine: settings, metrics, buffers, config, frames, hashes. `Wardx.Core.csproj` / `Wardx.Core.asmdef`. |
| `Tests/Wardx.Tests.csproj` | `dotnet run` test host (`npm run test:csharp`). |

Exports: `WardxClient`, `WardxOptions`, `WardxBehaviour` (Unity), `Dims`, `ConsoleTracer`, `WardxNameAttribute`. Namespace `Wardx`.

`WardxClient.Create(options)` is `UnityBootstrap.Start` or `DotnetBootstrap.Start` after `Settings.Resolve`.

## Contracts not to break

- Measure path is synchronous and allocation-light. No `await` inside `Inc` / `Set` / `Observe` / `Event` / `Log.*` / `Config.Get`.
- Failed sync increments `FramesFailed` and drops that envelope. Do not retry the same frames. Do not write a disk queue.
- `Role` cannot be `*`. It is client-selected routing metadata, not authorization; Remote Config never contains secrets. Required create keys are `Endpoint`, `ProjectKey`, `Project`, `Role`, `AppVersion`, `Environment`. Do not default them in code. `WardxBehaviour` may fill empty `AppVersion` from `Application.version` only.
- Histogram buckets are immutable per series. Changing them throws.
- Distinct identifiers are salted and hashed locally; frames contain only the
  fixed `p=9` HLL sketch. Keep `PrivacySalt` stable across workers.
- Dimension count/length limits and series caps return no-op series and increment `CardinalityDropped`. Invalid value types and invalid enum values throw; do not turn cardinality limits into exceptions.
- `Config.Get` never blocks on network. Missing key → caller fallback.
- `Identify(subjectId)` sets the instance default subject. `Identify(null)` clears it. Empty string throws. Per-call `subjectId` overrides it. A `game-server` that serves many users must pass `subjectId` per call and must not `Identify()`.
- `Experiment.Goal` throws without a subject (`Identify` or `subjectId`). Exposure payload hashes the subject with the required explicit `PrivacySalt`. Raw `subjectId` does not go on the wire. Same `subjectId` + experiment `id` + `salt` → same variant; do not persist the group.
- Tracer is an optional `ITracer`; subclass `TracerBase` to override only needed
  hooks: `Measure`, `Event`, `Log`, `Frame`, `Sync`. It must not change frames,
  delivery, or config.
- Envelope `sdk.name` is `wardx-unity` under `#if UNITY_5_3_OR_NEWER`, else `wardx-csharp`. `client.platform` matches. Every `WardxClient.Create(...)` instance owns one ULID `instanceId` and one ULID `sessionId`; they are not process-wide.
- Sync delay is `SyncIntervalMs * random(SyncJitterMin, SyncJitterMax)`, recomputed every cycle.
- `FlushAsync` snapshots if dirty and sends without stopping scheduling.
  `ShutdownAsync` settles the active sync, attempts a final flush, and closes
  transport. `Stop()` cancels/closes without a final flush. Unity quit/destroy
  callbacks use `Stop()` and must not block the main thread on HTTP.

## Optional enum usage

Check the consumer's SDK version for enum overloads before generating code.
Strings stay supported; adopt enums only when requested or appropriate to the
application. Enums can name metrics, events, log messages, config keys, and goals.
Member names keep their case; `[WardxName]` supplies a stable explicit wire name.
There is no automatic casing or underscore-to-dot conversion.

```csharp
enum Signal { [WardxName("match.completed")] MatchCompleted }
enum Dimension { [WardxName("mode")] Mode }
enum GameMode { [WardxName("ranked")] Ranked, Casual }
```

With `using Wardx;`, these calls inside an application method share one series:

```csharp
wardx.Counter(Signal.MatchCompleted, Dims.Of(Dimension.Mode, GameMode.Ranked)).Inc();
wardx.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
```

`Dims.Of` accepts mixed string/enum keys. Enum values work in dimensions,
event/log attrs, histogram exemplars, and timer end dimensions without mutating
caller dictionaries. Limits apply to mapped strings. Undefined values, ambiguous
numeric aliases, and blank mappings throw; flag combinations need exactly one
declared member. Subject IDs, distinct identifiers, and connection options remain
strings. `Config.Get` accepts enum keys, not enum result values. Goals retain
normal exposure/subject requirements. Preserve wire names across migrations.

## Enum implementation

`WardxClient`, `WardxCore`, their log APIs, config reads, and goals use constrained
generic enum overloads that resolve names and delegate to the existing string
methods. Preserve those string signatures and their behavior. `EnumNames`
caches member names or `WardxNameAttribute` mappings; reject undefined values,
ambiguous aliases, and blank mappings rather than sending numeric enum values.

`Dims.Of` object-key overloads accept only strings or enums. `Dimensions.Validate`
normalizes enum values before checking limits and constructing series keys.
Event/log buffers normalize enum attrs before storage. Do not mutate caller
collections or serialize enum ordinals. The server still receives strings;
this feature requires no protocol or catalog changes.

`Tests/EnumTests.cs` covers string/enum series equivalence, serialized payloads,
config and goals, dictionary preservation, mapped-value limits, and rejected
values. Include these cases when changing enum handling. .NET tests do not
establish Unity/IL2CPP runtime behavior.

## Settings

`Settings.Resolve` merges `SdkDefaults` under caller options, then validates. `SdkDefaults` must stay aligned with `packages/core/defaults.json`.

Required caller fields, including `PrivacySalt`, are checked by `Settings.Resolve`
in `Runtime/Core/Settings.cs`. Operational overrides come from `SdkDefaults` and
must remain aligned with `packages/core/defaults.json`; consult those sources
rather than copying numeric defaults. `Tracer` is optional and not a default key.

## Verify

```bash
npm run test:csharp
npm run check:csharp
```

For documentation-only work, validate links and API claims without running the
test suite. For behavior changes, start with relevant tests. .NET checks do not
establish Unity player or IL2CPP behavior.

Prefer a real ingest server for sync assertions. Do not mock `WardxCore` inside client tests unless the change is transport-only.
