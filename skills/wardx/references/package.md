# wardx / @wardx/core internals

Use this file when changing `packages/node` or `packages/core`. Application instrumentation stays in [SKILL.md](../SKILL.md).

## Layout

### packages/node (`wardx`)

| Path | Role |
| --- | --- |
| `src/index.js` | `createWardx(options)`, re-exports `WardxNode`, `createConsoleTracer` |
| `src/WardxNode.js` | Runtime: identity ULIDs, aggregate timer, sync chain, envelope, gzip, apply config |
| `src/transport/HttpTransport.js` | Keep-alive `POST` to `/v1/sync` (appended when `endpoint` path is `/`), header `x-wardx-key` |
| `src/compression/gzip.js` | `gzipSync` / `gunzipSync` |
| `src/runtime/processMetrics.js` | `process.memoryUsage().rss` → `wardx.internal.process_rss_bytes` |
| `src/trace/createConsoleTracer.js` | stderr tracer; optional `options.stream` |

Exports: `createWardx`, `WardxNode`, `createConsoleTracer`. Node 20+. ESM.

`createWardx` is `new WardxNode(resolveSettings(options))`. Settings come from core.

### packages/core (`@wardx/core`)

| Path | Role |
| --- | --- |
| `src/WardxCore.js` | Metrics, buffers, config store, experiment resolver, frames, tracer wrap |
| `src/settings.js` | `resolveSettings`, `loadSdkDefaults`, `nextSyncDelayMs` |
| `src/protocol.js` | `PROTOCOL_VERSION`, `SDK_NAME` (`wardx-node`), `PLATFORM` (`node`), `INTERNAL`, required keys |
| `defaults.json` | Operational defaults. Loader throws if a required key is missing. No fallback values. |
| `src/metrics/` | Counter, Gauge, Histogram, HyperLogLog, Timer, MetricsRegistry, dimensions |
| `src/config/` | ConfigStore, ExperimentResolver, FNV-1a hashes |
| `src/frame/FrameBuilder.js` | Window snapshot; `splitToMaxBytes` with consecutive sequence numbers and observable row drops |
| `src/buffers/` | EventBuffer, LogBuffer — drop new rows when full |
| `src/trace/` | `emit`, measure wrappers |

The core does not send HTTP. A runtime (this Node package, or a future SDK) must.

## Contracts not to break

- Measure path is synchronous and allocation-light. No `await` inside `inc` / `set` / `observe` / `event` / `log.*` / `config.get`.
- Failed sync increments `framesFailed` and drops that envelope. Do not retry the same frames. Do not write a disk queue.
- `role` cannot be `*`. It is client-selected routing metadata, not authorization; Remote Config never contains secrets. Required create keys are listed in `REQUIRED_CREATE_KEYS`; do not default them in code.
- Histogram buckets are immutable per series. Changing them throws.
- Distinct identifiers are salted and hashed locally; frames contain only the
  fixed `p=9` HLL sketch. Keep `privacySalt` stable across workers.
- Invalid or over-cap dimensions return no-op series and increment `cardinalityDropped`. Do not throw on cardinality.
- `config.get` never blocks on network. Missing key → caller fallback.
- `identify(subjectId)` sets the SDK-instance default subject. `identify(null)` clears it. Per-call `{ subjectId }` overrides it. A `game-server` that serves many users must pass `subjectId` per call and must not share an instance default.
- `experiment.goal` throws without a subject (`identify` or `{ subjectId }`). Exposure payload hashes the subject with the required explicit `privacySalt`. Raw `subjectId` does not go on the wire. Same `subjectId` + experiment `id` + `salt` → same variant; do not persist the group.
- Tracer is duck-typed and optional. Hooks: core `measure`, `event`, `log`, `frame`; runtime also `sync`. Omit unused hooks. Tracer must not change frames, delivery, or config.
- Envelope `sdk.name` is `wardx-node`. `client.platform` is `node`. Every `createWardx()` instance owns one ULID `client.instanceId` and one ULID `sessionId`; they are not process-wide.
- Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`, recomputed every cycle. Aggregate and sync timers are `unref()`'d.
- `flush` snapshots if dirty and sends; it does not stop timers. `shutdown` stops timers, flushes, closes the HTTP agent, and is idempotent.

## Settings

`resolveSettings` merges `defaults.json` under caller options, then validates.

Required caller options, including `privacySalt`, are validated by `resolveSettings`
in `src/settings.js`. Read supported operational overrides and their values from
`defaults.json`; do not copy numeric defaults into integration code. `tracer` is
optional and not a default key. The privacy salt has no fallback.

## Verify

For documentation-only work, validate links and API claims without running tests.
For behavior changes, start with the relevant core or Node test file, then use
`npm run test:js` when the change crosses their shared contracts.

Node SDK tests: `packages/node/test/sdk.test.js` (ingest via `createIngestServer` + `listen`). Core tests: `packages/core/test/*.test.js`. Prefer a real ingest server for sync assertions. Do not mock `WardxCore` inside node tests unless the change is transport-only.
