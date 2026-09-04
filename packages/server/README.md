# @wardx/server

Single-process Wardx ingest, historical aggregates, Remote Config, experiments,
and MCP control. Node.js 20 or later is required.

Wardx has two application surfaces:

- SDKs call `POST /v1/sync` to upload bounded telemetry frames and download
  role-filtered config.
- Agents use MCP over stdio, or optional loopback-only Streamable HTTP, to read
  current/history aggregates and safely mutate config or experiments.

There is no admin REST API and no supported multi-replica deployment in this
release. Streamable HTTP exposes the same MCP tools, not a second control API.

## Install and run

```bash
npm install @wardx/server
wardx-server /absolute/path/to/wardx-server.json
```

Repository commands:

```bash
npm run server
npm run verify
npm run verify:release
```

`GET /health` is liveness only. It does not prove SQLite writability, capacity,
or MCP readiness.

## Programmatic startup

`createIngestServer` and `startServer` accept the complete configuration object
directly; no JSON file is involved. Pass a dedicated Node HTTP-compatible server
to use HTTPS or customize the transport:

```js
import https from 'node:https';
import { startServer } from '@wardx/server';

export function startWardx(config, { key, cert }) {
  const transport = https.createServer({ key, cert });
  return startServer(config, { server: transport });
}
```

The supplied server must not already have a `request` listener. Wardx owns its
request handling and closes the server during `server.wardx.stop()`. The same
strict configuration validation applies to objects and JSON-loaded config.

## Required configuration

The configuration is closed-schema: every operational, retention, capacity, and
durability value is required and unknown keys fail startup. See
`config/development.json` for a complete example.

Important groups:

| Group | Purpose |
| --- | --- |
| `credentials` | Raw key to `{ label, project, allowedRoles, trustedForDecisions, enabled }`. |
| `sqlite` | Local path, WAL/synchronous/checkpoint policy, transaction and pending-write bounds. |
| `history` | Late-data policy, hour/day retention, app-version and query bounds. |
| `control` | Journal capacity and MCP read concurrency/pending bounds. |
| `mcpHttp` | Optional loopback Streamable HTTP listener, bearer source, boundary allowlists, and request bounds. |
| `capacity` | Maximum concurrent HTTP sync handlers. |
| `experiments` | Maximum active assignment-ledger rows. |
| `projects` | Initial Remote Config, role routing, experiments, and optional MCP catalog with `inspectEvents`. |
| `recentClientsMax`, `recentEventsMax`, `recentLogsMax` | Per-project caps for volatile in-memory rings. |

The operational JSON bootstraps each project only when `sqlite.path` is empty.
After that, SQLite is authoritative for project state. The JSON continues to be
the authority for process settings and credentials. Wardx does not import or
dual-write old JSON sidecars.

Credential example:

```json
{
  "credentials": {
    "replace-with-a-secret": {
      "label": "public-unity-client",
      "project": "game",
      "allowedRoles": ["unity"],
      "trustedForDecisions": false,
      "enabled": true
    },
    "replace-with-a-different-secret": {
      "label": "orders-verifier",
      "project": "game",
      "allowedRoles": ["backend"],
      "trustedForDecisions": true,
      "enabled": true
    }
  }
}
```

A credential cannot claim a role outside `allowedRoles`. Public clients must be
untrusted. Never store live credentials in version control or secrets in Remote
Config.

Raw recent event inspection is opt-in per project:

```json
{
  "catalog": {
    "inspectEvents": ["shot.traffic.hot_socket"]
  }
}
```

An absent or empty `inspectEvents` retains no raw event samples. Every event still
increments its aggregate count.

## Remote MCP through an SSH tunnel

Keep the MCP listener private on the Wardx host. Enable it with an explicit
loopback-only configuration; startup fails if the named environment variable is
missing or contains fewer than 32 bytes:

```json
{
  "mcpHttp": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8788,
    "path": "/mcp",
    "bearerTokenEnvironmentVariable": "WARDX_MCP_TOKEN",
    "maxRequestBytes": 65536,
    "maxConcurrentRequests": 8,
    "allowedHosts": ["127.0.0.1", "localhost"],
    "allowedOrigins": [
      "http://127.0.0.1:8788",
      "http://localhost:8788"
    ]
  }
}
```

Inject the same high-entropy `WARDX_MCP_TOKEN` into the Wardx service and Codex
Desktop; do not write it into either JSON or the tunnel definition. From the Mac,
the equivalent manual tunnel is:

```bash
ssh -NT \
  -L 127.0.0.1:8788:127.0.0.1:8788 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  user@wardx-server.example
```

The native macOS lifecycle hook is the repository's
[`ops/macos/com.wardx.mcp-tunnel.plist.example`](../../ops/macos/com.wardx.mcp-tunnel.plist.example).
Copy it to `~/Library/LaunchAgents/com.wardx.mcp-tunnel.plist`, replace the SSH
target, validate it with `plutil -lint`, and load it with:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wardx.mcp-tunnel.plist
```

The SSH key must already work non-interactively and the host key must already be
trusted. `launchd` starts the tunnel at login and restarts it if it exits. This is
independent of Codex, so an MCP session cannot race tunnel startup or be expected
to repair its own connection.

Configure Codex Desktop to use the local end of the tunnel:

```toml
[mcp_servers.wardx]
url = "http://127.0.0.1:8788/mcp"
bearer_token_env_var = "WARDX_MCP_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Requests are accepted only after the path, Host, optional Origin, Bearer token,
body-size bound, and concurrent-request bound pass. The server never needs a
public MCP port; the only public boundary is SSH.

## HTTP sync

```http
POST /v1/sync
Content-Type: application/json
Content-Encoding: gzip
X-Wardx-Key: <credential>
```

The server authenticates the key, validates the bounded envelope, authorizes
`client.role`, preflights persistence capacity, accepts experiment evidence,
updates current aggregates/rings, and responds with the role's config when its
version changed.

| Status | Meaning |
| --- | --- |
| `200` | Accepted. |
| `400` | Invalid encoding body, envelope, experiment evidence, or project. |
| `401` | Missing, unknown, or disabled credential. |
| `403` | Credential cannot claim the requested role. |
| `413` | Compressed or decoded request exceeds the configured bound. |
| `415` | Unsupported content encoding. |
| `503` | Concurrent sync or pending persistence capacity is full. |
| `500` | Non-sensitive unexpected failure; details go to diagnostics. |

General telemetry is at-most-once and is never retried automatically.
Experiment evidence is committed transactionally before success. Proxies must
not retry `POST /v1/sync`.

## Current and historical aggregates

`get_aggregates` returns current in-memory minute windows. Current counters sum
deltas; gauges keep the latest timestamp; histograms merge compatible buckets
and retain the current-window max exemplar; distincts merge HLL registers and
return an approximate unique count; events count by name; logs count by
level/name when selected by `catalog.persistLogs`.

SQLite stores tier-neutral minute rows and deterministically compacts them to
hour and day. Historical counters sum, events/logs count, gauges retain
last/min/max/sample count, histograms merge count/sum/min/max/buckets, and
distincts merge as set unions. MCP exposes the distinct `estimate` and
`precision`, never identifiers or raw registers.
Historical rows retain role, environment, app version, and declared dimensions,
but never event/log attrs, exemplars, instance IDs, or subject hashes.

`get_recent_events` is the intentionally short-lived exception for event
drill-down. Each project owns a separate circular buffer of at most
`recentEventsMax` accepted rows whose names appear in that project's
`catalog.inspectEvents`. The oldest retained row is evicted when that project
reaches its cap; the cap is a count, not a time-to-live, so traffic rate
determines the effective retention period. Results are sorted by event timestamp
newest-first and can be limited or filtered by exact name, role, and listed
scalar attribute keys.

Allowlisted recent rows contain all of the event's raw attrs and client
`instanceId`. They are never written to SQLite and the buffer starts empty after
every process restart. Treat MCP access as privileged, keep both the allowlist
and `recentEventsMax` no larger than operationally needed, and do not emit
secrets or direct personal identifiers as event attrs. Events outside the
allowlist and all historical/current aggregates remain counts by name and role
without attrs or instance IDs.

Use MCP `get_aggregate_history` with:

```json
{
  "project": "game",
  "tier": "day",
  "from": 1787097600000,
  "to": 1787270400000,
  "role": "unity",
  "environment": "production",
  "appVersion": "2.4.1",
  "names": ["level.complete", "session.duration", "shot.traffic.hids"]
}
```

The range and returned rows are bounded by config. Results include bucket
finalization, drop counts, and the newest compacted source watermark. Source
retention never runs ahead of a durable downstream bucket and watermark.

Recent clients/events/logs and current aggregates are volatile; history survives
restart. `memory` and `ndjson` sinks are debugging outputs and are not read by
MCP.

## Safe config mutations

Every catalog, config, experiment, ship, and rollback mutation requires:

```json
{ "expectedVersion": 12, "reason": "why this change is needed" }
```

The project state and exactly one journal entry commit atomically in SQLite.
Version conflicts publish nothing and report the current version. Catalog edits
also advance the project version. `list_config_changes` returns bounded public
metadata. `rollback_config_change` applies a retained inverse as a new version;
it never decrements the version or rewrites history.

In-process example:

```js
server.wardx.control.setValue(
  'game',
  'matchmaking.timeoutMs',
  4000,
  ['backend'],
  { expectedVersion: 12, reason: 'reduce abandoned searches' }
);
```

## Fixed-horizon experiments

Every experiment declares an assignment unit and ledger retention. Descriptive
experiments omit every fixed-horizon field. A closable experiment declares the
complete plan before enablement:

```js
server.wardx.control.upsertExperiment('game', {
  id: 'difficulty-v2',
  enabled: true,
  allocation: 1,
  salt: 'difficulty-v2-salt',
  roles: ['unity', 'backend'],
  primaryMetric: 'session.time_ms',
  goalMetric: 'session.duration',
  assignmentUnitKind: 'session',
  outcomeKind: 'mean',
  control: 'control',
  targetSampleSizePerVariant: 200,
  earliestAnalysisAt: 1787875200000,
  familyWiseAlpha: 0.05,
  minimumEffect: 30000,
  direction: 'increase',
  terminalRetentionMs: 604800000,
  healthThresholds: {
    maxDroppedFrames: 0,
    maxDuplicateExposures: 10,
    maxDuplicateGoals: 10,
    maxConflictingGoals: 0,
    maxVariantConflicts: 0,
    maxUntrustedRows: 1000,
    maxLateRows: 0,
    maxMissingExposures: 0,
    maxImplicitExposures: 0
  },
  hypothesis: 'Lower level-three HP increases session duration',
  variants: [
    { key: 'control', weight: 50, values: { 'level.3.enemyHp': 100 } },
    { key: 'easy', weight: 50, values: { 'level.3.enemyHp': 70 } }
  ]
}, { expectedVersion: 12, reason: 'pre-register difficulty test' });
```

The SDK sends a 256-bit SHA-256 assignment hash, never a raw subject. The
non-queryable SQLite ledger accepts one exposure and one goal per assignment
unit, requires matching exposure/goal provenance, and counts duplicates,
conflicts, missing exposures, untrusted rows, and late rows separately.

`analyze_experiment` always shows all telemetry provenance, but only trusted
deduplicated rows are eligible. Before both sample and time horizons it returns
`collecting`. At the horizon Wardx runs Newcombe/Wilson conversion inference or
Welch mean inference with Holm family-wise correction. The first terminal
`winner`, `no_difference`, `inconclusive`, or `invalid` result is durable and
cannot flip after restart.

`ship_experiment` requires that persisted decision to be a healthy `winner`, as
well as current `expectedVersion` and `reason`. It copies the winning values,
disables the experiment, records the mutation, and schedules ledger expiry.

## MCP tools

Read tools include:

- `list_projects`, `get_project_overview`, `get_config`;
- `get_aggregates`, `get_aggregate_history`, `get_recent_events`, `get_recent_logs`;
- `list_experiments`, `analyze_experiment`, `list_config_changes`.

Mutation tools include catalog setters, `set_config_value`,
`delete_config_value`, `upsert_experiment`, `set_experiment_enabled`,
`ship_experiment`, and `rollback_config_change`. MCP reads are bounded by
`control.maxConcurrentMcpReads` and `control.maxPendingMcpReads`. Streamable HTTP
also enforces `mcpHttp.maxConcurrentRequests` and `mcpHttp.maxRequestBytes`.

## Operations

- Run exactly one Wardx process against one local SQLite file. Do not put it on
  NFS or share it between processes.
- Put a reverse proxy in front of HTTP for TLS, body/connection/rate limits, and
  graceful drain. Never enable POST retries.
- Back up the operational configuration source and SQLite database after
  draining and stopping Wardx. Preserve permissions. Restore them as one tested
  unit.
- On disk-full, permission, busy-timeout, or incompatible-schema failure,
  preserve the database and diagnostics. Do not delete it to force an empty
  start.
- Graceful `SIGTERM`/`SIGINT` or `await server.wardx.stop()` drains accepted
  history, checkpoints WAL according to config, closes sinks, and closes SQLite.
- Capacity claims require the full-feature sustained/burst stress output on the
  stated local-SSD hardware. Unit and loopback tests do not prove production
  capacity.

## Exports

| Export | Purpose |
| --- | --- |
| `createIngestServer(config, { server? })` | Create Wardx on its HTTP server or a supplied Node server. |
| `listen(server, port, host)` | Listen and return the bound address. |
| `startServer(config, { server? })` | Create, listen, optionally start MCP HTTP, and install signal shutdown. |
| `loadServerConfig(path)` | Read and strictly validate operational JSON. |
| `ControlService` | In-process MCP/control implementation. |
| `executeTool` | MCP tool dispatcher used by stdio and tests. |
| `FrameAggregator` | Current one-minute aggregation. |
| `NullSink`, `MemorySink`, `NdjsonSink` | Optional envelope debug sinks. |

Detailed wire and component contracts live in `docs/PROTOCOL.md` and
`docs/ARCHITECTURE.md`.
