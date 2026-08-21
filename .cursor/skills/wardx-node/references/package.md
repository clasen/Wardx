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
| `src/metrics/` | Counter, Gauge, Histogram, Timer, MetricsRegistry, dimensions |
| `src/config/` | ConfigStore, ExperimentResolver, FNV-1a hashes |
| `src/frame/FrameBuilder.js` | Window snapshot; `fitToMaxBytes` |
| `src/buffers/` | EventBuffer, LogBuffer — drop new rows when full |
| `src/trace/` | `emit`, measure wrappers |

The core does not send HTTP. A runtime (this Node package, or a future SDK) must.

## Contracts not to break

- Measure path is synchronous and allocation-light. No `await` inside `inc` / `set` / `observe` / `event` / `log.*` / `config.get`.
- Failed sync increments `framesFailed` and drops that envelope. Do not retry the same frames. Do not write a disk queue.
- `role` cannot be `*`. Required create keys are listed in `REQUIRED_CREATE_KEYS`; do not default them in code.
- Histogram buckets are immutable per series. Changing them throws.
- Invalid or over-cap dimensions return no-op series and increment `cardinalityDropped`. Do not throw on cardinality.
- `config.get` never blocks on network. Missing key → caller fallback.
- `experiment.goal` throws without `subjectId`. Exposure payload hashes the subject (`privacySalt` or `projectKey`). Raw `subjectId` does not go on the wire.
- Tracer is duck-typed and optional. Hooks: core `measure`, `event`, `log`, `frame`; runtime also `sync`. Omit unused hooks. Tracer must not change frames, delivery, or config.
- Envelope `sdk.name` is `wardx-node`. `client.platform` is `node`. `client.instanceId` / `sessionId` are one ULID each per process.
- Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`, recomputed every cycle. Aggregate and sync timers are `unref()`'d.
- `flush` snapshots if dirty and sends; it does not stop timers. `shutdown` stops timers, flushes, closes the HTTP agent, and is idempotent.

## Settings

`resolveSettings` merges `defaults.json` under caller options, then validates.

Required from caller: `endpoint`, `projectKey`, `project`, `role`, `appVersion`, `environment`.

Required from defaults (override allowed): `aggregateIntervalMs` (1000), `syncIntervalMs` (15000), `syncJitterMin` (0.85), `syncJitterMax` (1.15), `maxBufferedEvents` (5000), `maxBufferedLogs` (2000), `maxFrameBytes` (524288), `maxSeriesPerMetric` (1000), `maxDimensionKeys` (8), `maxDimensionValueLength` (64), `httpTimeoutMs` (10000), `histogramBuckets` (`[10, 25, 50, 100, 250, 500, 1000]`).

`tracer` is not a default key. `privacySalt` empty → `projectKey`.

## Verify

```bash
npm test
```

Node SDK tests: `packages/node/test/sdk.test.js` (ingest via `createIngestServer` + `listen`). Core tests: `packages/core/test/*.test.js`. Prefer a real ingest server for sync assertions. Do not mock `WardxCore` inside node tests unless the change is transport-only.
