# @wardx/server internals

Use this file when changing `packages/server`. HTTP remains the client path. MCP remains the control plane.

## Layout

| Path | Role |
| --- | --- |
| `src/cli.js` | Loads `process.argv[2]`, `startServer`, MCP stdio when stdin is not a TTY |
| `src/server.js` | `createIngestServer`, `listen`, `startServer` |
| `src/loadConfig.js` | Required keys, no fallback path, no default values |
| `src/ingest/` | `POST /v1/sync` body, validate, respond |
| `src/control/ControlService.js` | Config, catalog, experiments, aggregates, logs. Overview outcomes include `topHistograms` (ranked by max). |
| `src/control/catalog.js` | Catalog shape, onboarding gaps, protocol-signal skip |
| `src/control/persist.js` | Rewrite loaded JSON (`config.configPath`) after mutations; experiment lifetime sidecar |
| `src/mcp/tools.js` | `TOOL_DEFS` + `executeTool` |
| `src/mcp/stdio.js` | MCP server, `MCP_INSTRUCTIONS`, `wardx://project/{name}` |
| `src/aggregation/FrameAggregator.js` | 1-minute windows per project; lifetime experiment totals |
| `src/control/experimentDecision.js` | `analyze_experiment` verdict and ship gate |
| `src/projects/ProjectRegistry.js` | Isolated per-project stores |
| `src/roles.js` | Role names, `["*"]`, per-role snapshot filter |
| `src/sinks/` | Envelope store: `null`, `memory`, `ndjson`. MCP does not read it |

Exports: `createIngestServer`, `listen`, `startServer`, `loadServerConfig`, `ControlService`, `executeTool`, `TOOL_DEFS`, `FrameAggregator`, `ConfigRepository`, sinks.

`server.wardx` on the HTTP server is `{ config, registry, control, sink }` for tests.

## Contracts not to break

- No admin HTTP routes. New control operations are MCP tools (and `executeTool` cases) plus tests.
- `projectKeys` maps ingest key → project name. MCP tools take the name.
- Catalog fields never go down `/v1/sync`. `toClientExperiment` / `toWireExperiment` strip `hypothesis` and, on the wire, `roles`, `goalKind`, `control`, `minExposures`, `confidence`, and `shippedVariant`.
- Catalog persist does not increment `version`. `_commit` increments `version` then persists.
- `loadServerConfig` throws if the path is missing. Do not add fallback defaults for required config keys.
- `variant.values` keys must already exist and be visible to `experiment.roles` (`assertExperimentKeysExist`).
- Protocol names `wardx.internal.*`, `experiment.exposure`, `experiment.goal` stay out of onboarding gap lists (`isProtocolSignal`).
- Envelope sink is process-wide and outside ControlService. Production uses `sink: "null"`.
- Experiment lifetime totals persist at `<configPath>.experiment-stats.json` when `configPath` is set. The sidecar is not part of the client snapshot. A missing sidecar is empty stats. A corrupt sidecar is a startup error.

## Config file keys

Required: `host`, `port`, `projectKeys`, `sink`, `maxRequestBytes`, `aggregateRetentionMinutes`, `aggregateMaxSeriesPerMetric`, `memorySinkMaxEnvelopes`, `recentClientsMax`, `recentLogsMax`, `projects`.

`ndjsonPath` is required when `sink` is `ndjson`. Each `projects.<name>` requires `version`, `values`, `keyRoles`, `experiments`. Optional `catalog`: `description`, `roles`, `signals`, `experiments` (id → `{ hypothesis }`). Experiment lifetime totals are not in this file; they live at `<configPath>.experiment-stats.json`.

This repo: `config/development.json` (memory sink), `config/production.json` (null sink). CLI: `npm run server`.

## Verify

```bash
npm test
```

Server tests live in `packages/server/test/*.test.js`. Prefer `executeTool` for MCP-shaped assertions and `createIngestServer` + `fetch` for ingest. Helpers: `packages/server/test/helpers.js`.
