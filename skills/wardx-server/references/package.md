# @wardx/server internals

Use this file when changing `packages/server`. HTTP remains the client path. MCP remains the control plane.

## Layout

| Path | Role |
| --- | --- |
| `src/cli.js` | Loads `process.argv[2]`, `startServer`, MCP stdio when stdin is not a TTY |
| `src/server.js` | `createIngestServer`, `listen`, `startServer`; awaitable `server.wardx.stop()` |
| `src/loadConfig.js` | Required keys, no fallback path, no default values |
| `src/ingest/` | `POST /v1/sync` body, validate, respond |
| `src/control/ControlService.js` | Config, catalog, experiments, aggregates, logs. Overview outcomes include `topHistograms` (ranked by max). |
| `src/control/catalog.js` | Catalog shape, onboarding gaps, protocol-signal skip |
| `src/control/persist.js` | Rewrite loaded JSON (`config.configPath`) after mutations; sidecar paths, snapshots, hydration, and validation |
| `src/control/PersistenceCoordinator.js` | Coalesced async sidecar writes; one write path; dirty retry state; shutdown flush |
| `src/diagnostics.js` | Structured `stderr` or `none` diagnostic sink with non-recursive failure handling |
| `src/mcp/tools.js` | `TOOL_DEFS` + `executeTool` |
| `src/mcp/stdio.js` | MCP server, `MCP_INSTRUCTIONS`, `wardx://project/{name}` |
| `src/aggregation/FrameAggregator.js` | 1-minute windows per project (persisted); lifetime experiment totals; persist-log lifetime rollups |
| `src/control/experimentDecision.js` | `analyze_experiment` verdict and ship gate |
| `src/projects/ProjectRegistry.js` | Isolated per-project stores |
| `src/roles.js` | Role names, `["*"]`, per-role snapshot filter |
| `src/sinks/` | Envelope store: `null`, `memory`, `ndjson`. MCP does not read it |

Exports: `createIngestServer`, `listen`, `startServer`, `loadServerConfig`, `ControlService`, `executeTool`, `TOOL_DEFS`, `FrameAggregator`, `ConfigRepository`, sinks.

`server.wardx` on the HTTP server is `{ config, registry, control, sink, persistence, diagnostics, stop }`. Embedded callers await `stop()`.

## Contracts not to break

- No admin HTTP routes. New control operations are MCP tools (and `executeTool` cases) plus tests.
- `projectKeys` maps ingest key → project name. MCP tools take the name. The key authenticates the project; client-selected roles are routing metadata, not authorization. Remote Config never contains secrets.
- Catalog fields never go down `/v1/sync`. `toClientExperiment` / `toWireExperiment` strip `hypothesis` and, on the wire, `roles`, `goalKind`, `control`, `minExposures`, `confidence`, and `shippedVariant`.
- Catalog persist does not increment `version`. `_commit` increments `version` then persists.
- `loadServerConfig` throws if the path is missing. Do not add fallback defaults for required config keys.
- `variant.values` keys must already exist and be visible to `experiment.roles` (`assertExperimentKeysExist`).
- Protocol names `wardx.internal.*`, `experiment.exposure`, `experiment.goal` stay out of onboarding gap lists (`isProtocolSignal`).
- Envelope sink is process-wide and outside ControlService. Production uses `sink: "null"`.
- Experiment lifetime totals persist at `<configPath>.experiment-stats.json` when `configPath` is set. The sidecar is not part of the client snapshot. A corrupt sidecar is a startup error and is never silently discarded.
- Catalog `persistLogs` is an allowlist of exact log message names. Lifetime count + last exemplar persist at `<configPath>.log-stats.json` under the same rules. MCP `set_persist_log` / `delete_persist_log` mutate the allowlist without bumping `version`.
- 1-minute aggregate windows persist at `<configPath>.aggregate-windows.json` under the same rules and expire exactly at `aggregateRetentionMinutes`. The bounded recent-client and recent-log rings do not persist.

## Config file keys

Required: `host`, `port`, `projectKeys`, `sink`, `maxRequestBytes`, `maxClockSkewMs`, `maxFramesPerEnvelope`, `maxItemsPerEnvelope`, `maxNameBytes`, `maxDimensionKeys`, `maxDimensionValueLength`, `maxAttributeKeys`, `maxAttributeValueLength`, `aggregateRetentionMinutes`, `aggregateMaxSeriesPerMetric`, `memorySinkMaxEnvelopes`, `recentClientsMax`, `recentLogsMax`, `persistenceFlushIntervalMs`, `diagnostics`, `projects`. No required key has a fallback. `diagnostics.sink` is `stderr` or `none`.

`ndjsonPath` is required when `sink` is `ndjson`. Each `projects.<name>` requires `version`, `values`, `keyRoles`, `experiments`; every experiment requires `goalMetric`. Optional `catalog`: `description`, `roles`, `signals`, `persistLogs` (exact log message names), `experiments` (id → `{ hypothesis }`). Experiment lifetime totals are not in this file; they live at `<configPath>.experiment-stats.json`. Allowlisted log rollups live at `<configPath>.log-stats.json`. 1-minute windows live at `<configPath>.aggregate-windows.json`.

The config is authoritative for keys/catalog/definitions. Experiment and persist-log sidecars are authoritative for their lifetime rollups. Aggregate windows are retained only for `aggregateRetentionMinutes` and are not rebuildable inside Wardx with `sink: "null"`. Back up and restore all four files as one stopped snapshot. Startup crashes on corruption. Do not add recovery fallbacks or compatibility readers.

This repo: `config/development.json` (memory sink), `config/production.json` (null sink). CLI: `npm run server`.

## Verify

```bash
npm test
```

Server tests live in `packages/server/test/*.test.js`. Prefer `executeTool` for MCP-shaped assertions and `createIngestServer` + `fetch` for ingest. Helpers: `packages/server/test/helpers.js`.
