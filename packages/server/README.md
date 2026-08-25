# @wardx/server

Single-process Wardx ingest, historical aggregates, Remote Config, experiments,
and MCP control. Node.js 20 or later is required.

Wardx has two interfaces:

- SDKs call `POST /v1/sync` to upload bounded telemetry frames and download
  role-filtered config.
- Agents use MCP stdio to read current/history aggregates and safely mutate
  config or experiments.

There is no admin HTTP API and no supported multi-replica deployment in this
release.

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

## Required configuration

The JSON config is closed-schema: every operational, retention, capacity, and
durability value is required and unknown keys fail startup. See
`config/development.json` for a complete example.

Important groups:

| Group | Purpose |
| --- | --- |
| `credentials` | Raw key to `{ label, project, allowedRoles, trustedForDecisions, enabled }`. |
| `sqlite` | Local path, WAL/synchronous/checkpoint policy, transaction and pending-write bounds. |
| `history` | Late-data policy, hour/day retention, app-version and query bounds. |
| `control` | Journal capacity and MCP read concurrency/pending bounds. |
| `capacity` | Maximum concurrent HTTP sync handlers. |
| `experiments` | Maximum active assignment-ledger rows. |
| `projects` | Initial Remote Config, role routing, experiments, and optional MCP catalog. |

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
and retain the current-window max exemplar; events count by name; logs count by
level/name when selected by `catalog.persistLogs`.

SQLite stores tier-neutral minute rows and deterministically compacts them to
hour and day. Historical counters sum, events/logs count, gauges retain
last/min/max/sample count, and histograms merge count/sum/min/max/buckets.
Historical rows retain role, environment, app version, and declared dimensions,
but never event/log attrs, exemplars, instance IDs, or subject hashes.

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
  "names": ["level.complete", "session.duration"]
}
```

The range and returned rows are bounded by config. Results include bucket
finalization, drop counts, and the newest compacted source watermark. Source
retention never runs ahead of a durable downstream bucket and watermark.

Recent clients/logs and current aggregates are volatile; history survives
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
- `get_aggregates`, `get_aggregate_history`, `get_recent_logs`;
- `list_experiments`, `analyze_experiment`, `list_config_changes`.

Mutation tools include catalog setters, `set_config_value`,
`delete_config_value`, `upsert_experiment`, `set_experiment_enabled`,
`ship_experiment`, and `rollback_config_change`. MCP reads are bounded by
`control.maxConcurrentMcpReads` and `control.maxPendingMcpReads`.

## Operations

- Run exactly one Wardx process against one local SQLite file. Do not put it on
  NFS or share it between processes.
- Put a reverse proxy in front of HTTP for TLS, body/connection/rate limits, and
  graceful drain. Never enable POST retries.
- Back up the operational JSON and SQLite database after draining and stopping
  Wardx. Preserve permissions. Restore them as one tested unit.
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
| `createIngestServer(config)` | Create the HTTP server and `server.wardx` services. |
| `listen(server, port, host)` | Listen and return the bound address. |
| `startServer(config)` | Create, listen, and install signal shutdown. |
| `loadServerConfig(path)` | Read and strictly validate operational JSON. |
| `ControlService` | In-process MCP/control implementation. |
| `executeTool` | MCP tool dispatcher used by stdio and tests. |
| `FrameAggregator` | Current one-minute aggregation. |
| `NullSink`, `MemorySink`, `NdjsonSink` | Optional envelope debug sinks. |

Detailed wire and component contracts live in `docs/PROTOCOL.md` and
`docs/ARCHITECTURE.md`.
