# @wardx/server integration and internals

## Choose the lifecycle owner

| API | Ingest transport | MCP HTTP | Signals and shutdown |
| --- | --- | --- | --- |
| `await createWardxHandler(config)` | Returns `handler(req, res)`; no ingest server or listener. | Starts when enabled. | No process signals/exit; caller retains and awaits `stop()`. |
| `createIngestServer(config, { server? })` | Returns a default or injected Node server without listening. | Does not start it. | Caller listens and handles signals; `server.wardx.stop()` closes the owned transport and runtime. |
| `await startServer(config, { server? })` | Creates/attaches and listens. | Starts when enabled. | Installs SIGINT/SIGTERM handlers that stop Wardx and exit; explicit `server.wardx.stop()` is also available. |

An injected `options.server` must have no existing `request` listener. For a
shared or framework-owned HTTPS server, use the handler API instead of starting
an extra HTTP server and forwarding requests through `emit('request')`.

```js
import { createWardxHandler } from '@wardx/server';

const { handler, stop, mcpAddress, config } = await createWardxHandler(serverConfig);
// When the framework expects a factory rather than a request listener:
const siteApp = () => handler;
```

The result is `{ handler, stop, mcpAddress, config }`; MCP address is null when
disabled. Pass `handler` directly to a Node HTTP/HTTPS transport or mount through
the framework. Keep `stop` accessible from the application's shutdown hook;
exporting only `siteApp` is not a complete lifecycle integration.

`stop()` returns the same promise on repeated calls, marks `/ready` unavailable,
rejects new application requests with 503, closes MCP, drains accepted ingest
work, flushes persistence, and closes SQLite. `/health` and `/ready` remain
available for diagnostics. The external transport belongs to the application:
it must stop accepting connections and drain/close that transport before exit.
Its request timeouts also bound how long incomplete requests can hold shutdown.
MCP startup failures release the initialized Wardx resources.

All APIs require the complete validated config. Handler mode does not listen on
ingest `host`/`port`; MCP still uses its configured host/port. MCP reads the token
from `mcpHttp.bearerTokenEnvironmentVariable` during initialization. There is no
public `mcpToken` argument; provide it through the deployment environment without
printing it. A temporary `process.env` override is global, not per-instance.

Use an absolute `sqlite.path` for programmatic config: relative paths resolve
against cwd without `configPath`, or against the config file's directory with it.
Check installed exports before recommending `createWardxHandler`; do not infer
npm availability from this checkout or silently substitute the forwarding bridge.

## Main boundaries

| Path | Responsibility |
| --- | --- |
| `src/server.js` | Shared ingest runtime, handler API, transport/MCP startup, and shutdown. |
| `src/loadConfig.js` | Closed required operational config; no defaults. |
| `src/auth/CredentialRegistry.js` | Authenticate raw keys and authorize claimed roles. |
| `src/ingest/` | Bounded HTTP read/validation and pre-mutation capacity checks. |
| `src/storage/SqliteStateStore.js` | Schema v2, WAL, project state, journal, aggregate tiers, watermarks, and retention tables. |
| `src/storage/RetentionLedger.js` | Explicit activity cohorts, pinned salt fingerprints, and D1/D7/D30 returns. |
| `src/storage/ExperimentLedger.js` | Durable SHA-256 assignment dedupe, provenance, totals, terminal output/expiry. |
| `src/aggregation/history/` | Canonical historical rows and deterministic compaction. |
| `src/events/RecentEvents.js` | Per-project allowlisted, bounded volatile event samples and filters. |
| `src/control/ControlService.js` | MCP reads/mutations, experiment gates, journal publish. |
| `src/control/MutationJournal.js` | CAS, audit-safe reversible entry, rollback-as-new-version. |
| `src/control/PersistenceCoordinator.js` | Coalesced minute writes, restart scans, compaction, retention, metrics. |
| `src/mcp/` | Public schemas, bounded reads, stdio and loopback Streamable HTTP resources/tools. |

## Contracts

- No admin HTTP route and no multi-process/shared-SQLite mode.
- Optional MCP HTTP binds only to loopback and requires one environment-sourced
  Bearer token plus path, Host/Origin, body, and concurrency bounds.
- Operational configuration passed as an object or loaded from JSON owns
  settings/credentials and bootstraps an empty DB. SQLite owns project state
  thereafter. Do not add sidecar or compatibility fallback.
- Every config/catalog/experiment mutation uses `expectedVersion` and `reason`.
  Commit project state and one journal entry atomically before `_publish`.
- Catalog signal entries contain a required `description` and optional exact
  `category`. Category is attached by name at read time, never stored in metric
  dimensions or historical aggregate rows.
- Credential trust comes only from `CredentialRegistry`; never from wire data.
- General history is preflighted then coalesced. Experiment evidence is
  transactionally accepted before HTTP success.
- Historical rows exclude attrs, exemplars, instance IDs, and subject hashes;
  only `catalog.inspectEvents` names may enter the volatile recent-event ring
  that exposes raw event attrs and instance IDs.
- Source retention requires durable downstream bucket plus watermark.
- Fixed-horizon plans are all-or-none and immutable after trusted exposure.
  Terminal analysis is first-write-wins.
- Current aggregates/rings are memory-only. `catalog.inspectEvents` selects and
  `recentEventsMax` bounds each project's event ring. Hour/day history and
  experiment evidence survive restart.
- All bounds live in config: sync handlers, pending SQLite batches/bytes,
  write batch, transaction/busy/checkpoint policy, history ranges/rows/
  retention/cardinality, journal, MCP reads, and ledger rows.

## Required config groups

Top-level required groups include `credentials`, `sqlite`, `history`, `control`,
`mcpHttp`, `capacity`, `experiments`, `retention`, and `projects`, in addition to
HTTP/envelope/sink/current-window settings. See `REQUIRED*` in
`src/loadConfig.js`; never duplicate that list here in code or add a fallback.

Each credential contains `label`, `project`, `allowedRoles`,
`trustedForDecisions`, and `enabled`. Each project contains `version`, `values`,
`keyRoles`, `experiments`, and optional `catalog`. Every experiment has
`goalMetric`, `assignmentUnitKind`, `terminalRetentionMs`, roles, and variants.

Retention config requires `maxUsersPerProject` and `maxQueryDays`. User state
does not expire; capacity rejects new users rather than reenrolling existing
ones. Salt fingerprints are pinned per project and changes are rejected.
SQLite schema v1 upgrades transactionally to v2 at startup; older binaries
cannot open v2. Obtain production startup/migration authorization before using
that upgrade on a live database.

## Verification

```bash
npm run lint
npm run typecheck
npm run test:js
npm run test:csharp
npm run check:csharp
npm run stress:smoke
npm run pack:check
```

Use only checks relevant to the change; docs-only edits need link/API validation,
not the test suite. For handler/lifecycle changes, start with
`node --test packages/server/test/handler.test.js`, then broaden for shared runtime
changes. Socket tests need loopback capability.

Ask before `npm run verify` or `npm run verify:release`, as required by this
repository's AGENTS.md. Do not run `stress:full` without explicit full-stress or
`verify:release` authorization. Stress results are hardware evidence, not
production or deterministic unit-test proof.
