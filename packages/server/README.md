# @wardx/server

Single-process Wardx ingest, historical aggregates, Remote Config, experiments,
and MCP control. Node.js 20 or later is required.

Wardx has two application surfaces:

- SDKs call `POST /v1/sync` to upload bounded telemetry frames and download
  role-filtered config.
- Agents use MCP over stdio, or optional Streamable HTTP on the ingest port, to
  read current/history aggregates and safely mutate config or experiments.

There is no admin REST API and no supported multi-replica deployment in this
release. Streamable HTTP exposes the same MCP tools, not a second control API.

## Install and run

```bash
npm install @wardx/server
```

### Start from code

`startServer` accepts a complete configuration object from your application's
configuration module; no JSON file is required. In this example, `wardx.config.js`
is your own module exporting that object. Use the
[complete development configuration](https://github.com/clasen/Wardx/blob/main/config/development.json)
as a reference for the required fields, then supply your deployment's settings
and credentials.

```js
import { startServer } from '@wardx/server';
import config from './wardx.config.js';

const { server, address } = await startServer(config);

// Call during application shutdown.
async function stopWardx() {
  await server.wardx.stop();
}
```

The result is `{ server, address, config }`. `address` is the bound address,
which also serves MCP HTTP when it is enabled. `startServer` opens the listener
and installs `SIGINT`/`SIGTERM` handlers that drain Wardx and exit the process.

If your application owns signal handling, use `createIngestServer(config)` and
`await listen(server, config.port, config.host)` instead, then call
`await server.wardx.stop()` from its shutdown handler. `createIngestServer`
returns the server directly; it does not listen or install signal handlers.

### Handler for an application-owned HTTP or HTTPS server

Use `createWardxHandler` when your framework owns the transport and process
lifecycle. It initializes Wardx, including the configured MCP HTTP route, but
does not create or listen on a server, install signal handlers, or exit the
process. The MCP bearer token uses the same environment variable as
`startServer`.

```js
import { createWardxHandler } from '@wardx/server';

export async function createWardxSite({ credentials, server }) {
  const { handler, stop } = await createWardxHandler({
    ...server,
    credentials
  });
  return { siteApp: () => handler, stop };
}
```

The result is `{ handler, stop, config }`. `handler(req, res)` is a
Node request listener; pass it directly to `https.createServer(tls, handler)`
or mount it through your framework. The factory `siteApp: () => handler` above
is only needed when the framework expects a handler factory. The complete
server configuration is still required, although `host` and `port` do not open
a listener in this mode. The handler also serves MCP HTTP at `mcpHttp.path`
when it is enabled.

Retain `stop` in your application's shutdown integration. Calling `stop()` marks
readiness as unavailable, rejects new application requests with 503, closes MCP,
waits for accepted ingest work, flushes persistence, and closes SQLite. Repeated
calls return the same promise. `/health` and `/ready` remain diagnostic endpoints.
Wardx does not close your external transport: the application must also stop
accepting connections and drain/close its HTTP or HTTPS server before exiting.
Configure request timeouts on that transport so incomplete requests cannot hold
shutdown indefinitely. A missing or short MCP bearer token fails startup before
Wardx opens SQLite.

SDK clients sync every `syncIntervalMs` (15 seconds by default, with a jitter
factor up to 1.15) and reuse a keep-alive connection when the server still has it
open. Node closes idle keep-alive connections after `server.keepAliveTimeout`,
which defaults to 5 seconds. With these defaults, every sync opens a new TCP and
TLS connection. To reuse connections, set `keepAliveTimeout` on the transport you
own above the largest sync delay, for example 20 seconds. Each active client then
holds one idle socket between syncs.

### HTTPS and custom transport

Both startup functions accept a dedicated Node HTTP-compatible server:

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

### CLI with a JSON configuration

Alternatively, save the complete configuration as JSON and run the local binary:

```bash
npx wardx-server /absolute/path/to/wardx-server.json
```

The CLI also starts MCP over stdio when stdin is not a TTY. Programmatic
`startServer` does not start stdio MCP; it serves MCP HTTP on the ingest port
when `mcpHttp.enabled` is true.

Repository commands:

```bash
pnpm run server
pnpm run verify
pnpm run verify:release
```

`GET /health` is liveness only. It does not prove SQLite writability, capacity,
or MCP readiness.

`GET /ready` returns HTTP 200 when all operational checks pass, or 503 while
degraded or draining. Its body is `{ "ok": true, "checks": { "running": true,
"sqlite": true, "persistence": true, "capacity": true, "mcp": true },
"counters": { "retentionActivityDropped": 0, "retentionConversionsDropped": 0,
"retentionChannelsDropped": 0 } }`, with failed checks set to
false. Counters are process-wide since startup and do not affect `ok`. It
exposes no project names, values, paths, or errors.

## Required configuration

The configuration is closed-schema: every operational, retention, capacity, and
durability value is required and unknown keys fail startup. See the
[complete development configuration](https://github.com/clasen/Wardx/blob/main/config/development.json)
in the repository; it is not included in the npm package. Configuration snippets
below show individual fields or groups, not complete startup configurations.

Use an absolute `sqlite.path` when configuring Wardx from code. A relative path
in an object without `configPath` is relative to the process working directory;
when using `loadServerConfig(path)` or the CLI, it is relative to the JSON
configuration file's directory.

Important groups:

| Group | Purpose |
| --- | --- |
| `credentials` | Raw key to `{ label, project, allowedRoles, trustedForDecisions, enabled }`. |
| `sqlite` | Local path, WAL/synchronous/checkpoint policy, transaction and pending-write bounds. |
| `retention` | Persistent user capacity per project and maximum cohort query range. |
| `history` | Late-data policy, hour/day retention, app-version and query bounds. |
| `control` | Journal capacity and MCP read concurrency/pending bounds. |
| `mcpHttp` | Optional Streamable HTTP route on the ingest port, bearer source, and request bounds. |
| `capacity` | Maximum concurrent HTTP sync handlers and how long one may wait for its request body. |
| `readiness` | SQLite probe interval/timeout and maximum persistence lag. |
| `experiments` | Maximum active assignment-ledger rows. |
| `projects` | Initial Remote Config, role routing, experiments, and optional MCP catalog with categorized signals and `inspectEvents`. |
| `recentClientsMax`, `recentEventsMax`, `recentLogsMax` | Per-project caps for volatile in-memory rings. |

SQLite runs `PRAGMA optimize=0x10002` after opening and `PRAGMA optimize` during
the maintenance cycle controlled by `history.compactionIntervalMs`. This does
not change the configured WAL checkpoint threshold or synchronous mode.
`server.wardx.persistence.snapshotMetrics().sqlite` includes optimization and
explicit-checkpoint durations, plus a read-only WAL backlog sample. Transaction
duration includes any automatic checkpoint; explicit-checkpoint duration does
not measure automatic checkpoints. The server stress report exposes both.

The startup configuration, supplied as an object or loaded from JSON, bootstraps
each configured project only when that project has no stored state in SQLite.
This also applies to new projects added to an existing database. After bootstrap,
SQLite is authoritative for that project's values, role routing, experiments,
and catalog; editing their startup definitions does not overwrite stored state.
Use MCP or `server.wardx.control` to change that state. The startup configuration
continues to define process settings, credentials, and which projects are loaded.
Wardx does not import or dual-write old JSON sidecars.

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

Catalog signals document a Remote Config key, metric, event, or log once by
name. `category` is optional and accepts an exact open name; common values are
`business`, `performance`, `reliability`, and `security`:

```json
{
  "catalog": {
    "signals": {
      "checkout.completed": {
        "description": "Completed checkouts",
        "category": "business"
      },
      "http.duration_ms": {
        "description": "HTTP request duration in milliseconds",
        "category": "performance"
      }
    }
  }
}
```

Category is catalog metadata, not a metric dimension: it does not travel in
ingest frames or create additional series. `get_project_overview`,
`get_aggregates`, and `get_aggregate_history` accept an exact `category` filter;
overview also returns the project's sorted `categories` list. When `names` and
`category` are both supplied, Wardx returns their intersection.

## Connect an agent over MCP

Agents connect in one of two ways:

- **Remote, over HTTPS.** Wardx serves MCP at `mcpHttp.path` on the same port
  and transport as `POST /v1/sync`, for example
  `https://wardx.example.com/mcp`. No separate port, proxy route, or tunnel is
  needed.
- **Local, over stdio.** The agent spawns the `wardx-server` CLI itself.

### Remote: 1. Enable MCP HTTP on the server

Generate a token with `openssl rand -hex 32` and set it as `WARDX_MCP_TOKEN` in
the Wardx service environment. Startup fails if the variable is missing or
shorter than 32 bytes. Then enable MCP in the server configuration:

```json
{
  "mcpHttp": {
    "enabled": true,
    "path": "/mcp",
    "bearerTokenEnvironmentVariable": "WARDX_MCP_TOKEN",
    "maxRequestBytes": 65536,
    "maxConcurrentRequests": 8,
    "bodyTimeoutMs": 30000
  }
}
```

`path` cannot be `/health`, `/ready`, or `/v1/sync`.

Serve MCP only over HTTPS: the bearer token travels with every request. The
token grants full administrative control over Remote Config and experiments, so
keep it secret. To rotate it, change `WARDX_MCP_TOKEN` and restart Wardx.

### Remote: 2. Connect the agent

Both clients store the header in their configuration, so paste the token value
in place of `<token>` and keep that configuration out of version control.

Claude Code:

```bash
claude mcp add --transport http --scope user wardx https://wardx.example.com/mcp --header "Authorization: Bearer <token>"
```

Codex has no `mcp add` flag for a fixed header, so add the entry to
`~/.codex/config.toml`:

```toml
[mcp_servers.wardx]
url = "https://wardx.example.com/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

Requests are accepted only after the Bearer token, body-size bound, and
concurrent-request bound pass.

### Remote: several servers

Each Wardx server answers MCP only for its own projects. To reach more than one
server, add one MCP entry per server, each with a distinct name and its own
token:

```bash
claude mcp add --transport http --scope user wardx-a https://wardx-a.example.com/mcp --header "Authorization: Bearer <token-a>"
claude mcp add --transport http --scope user wardx-b https://wardx-b.example.com/mcp --header "Authorization: Bearer <token-b>"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.wardx-a]
url = "https://wardx-a.example.com/mcp"
http_headers = { Authorization = "Bearer <token-a>" }

[mcp_servers.wardx-b]
url = "https://wardx-b.example.com/mcp"
http_headers = { Authorization = "Bearer <token-b>" }
```

The agent client prefixes every tool with the entry name, so each call goes to
exactly one server. Projects with the same name on two servers are independent:
before a mutation, confirm the entry matches the server you intend to change.

### Local: stdio

The agent starts the whole server, including the ingest listener and SQLite, so
run only one process per configuration. Claude Code:

```bash
claude mcp add --scope user wardx -- npx wardx-server /absolute/path/to/wardx-server.json
```

Codex:

```bash
codex mcp add wardx -- npx wardx-server /absolute/path/to/wardx-server.json
```

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

Aggregate rows include catalog `description` and optional `category` metadata.
The same metadata is attached at read time to historical rows, so changing a
category does not rewrite stored aggregate buckets.

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
  "os": "android",
  "names": ["level.complete", "session.duration", "shot.traffic.hids"]
}
```

`os` keeps each operating system family as its own historical series; rows from
SDKs that do not report `os` never match an `os` filter. The range and returned
rows are bounded by config. Results include bucket
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

Remote Config keys can declare an optional server-only contract in their signal
metadata. For example, call MCP `set_signal` with:

```json
{
  "project": "game",
  "name": "matchmaking.timeoutMs",
  "description": "Maximum matchmaking wait in milliseconds",
  "constraint": { "type": "integer", "min": 0, "max": 60000 },
  "expectedVersion": 12,
  "reason": "Reject invalid matchmaking timeouts"
}
```

The stored representation is `catalog.signals[key].constraint`. `type` is
required and accepts `string`, `number`, `integer`, `boolean`, `object`, `array`,
or `null`. Numeric `min` and `max` are inclusive. Optional `enum` is a nonempty
list of unique scalar values matching the declared type and range; object and
array constraints only check type. Values are never coerced.

Constraints apply to bootstrap and hydrated SQLite state, config writes, conditional rule values, every
experiment variant including disabled experiments, and rollback. Invalid
candidates leave values, version, and journal unchanged. A constraint can be
declared before the key exists; keys without constraints remain unrestricted.
`set_signal` replaces the complete signal metadata: omitting `constraint`
removes it. Constraints appear in MCP metadata and never in SDK config replies.

### Conditional Remote Config

Upgrade the server to 0.9.0 before adopting SDK 0.9.0: older servers reject the new client fields. Older clients can sync with this server, but receive a snapshot on every successful sync because they do not return `configContext`.

Role routing still determines which keys and experiments a client receives. Optional ordered rules choose the base value of each visible key using `role`, `appVersion`, `environment`, `platform`, `os`, or an application-defined `attributes.<name>` field. `platform` identifies the SDK runtime and `os` the operating system family the SDK detected (`android`, `ios`, `macos`, …); use attributes for build, region, channel, or other application concepts.

For example, MCP `set_config_value` can receive:

```json
{
  "project": "game",
  "key": "matchmaking.timeoutMs",
  "value": 5000,
  "roles": ["app"],
  "rules": [
    {
      "when": [
        { "field": "attributes.region", "op": "in", "value": ["eu", "us"] },
        { "field": "attributes.tier", "op": "lte", "value": 2 }
      ],
      "value": 8000
    }
  ],
  "expectedVersion": 12,
  "reason": "Allow longer matchmaking on these clients"
}
```

All conditions in a rule must match, and the first matching rule wins. No match uses the stored base. `eq` compares scalar values strictly; `in` accepts a nonempty scalar list. `gt`, `gte`, `lt`, and `lte` compare finite numbers only. Missing fields and different types do not match. Attribute names are literal flat keys. Values replace the complete base, including objects and arrays; there is no deep merge or version-string parsing.

Omitting `rules` preserves existing rules when tuning a base value; `rules: []` clears them. In-process callers pass rules as the sixth argument to `control.setValue(project, key, value, roles, options, rules)`. Bootstrap and `get_config` use optional `keyRules`, a map from existing config keys to rule arrays. Overview knobs expose their rules. Rules participate in atomic writes, constraints, deletion, persistence, and rollback, but stay off the client wire.

The server resolves the base and returns a context token so changed attributes can refresh the snapshot without a new project version. Experiment variants still override that base locally for eligible roles and allocated subjects. Assignment, exposures, and goals are unchanged. `ship_experiment` updates the stored base and preserves rules; matching rules apply again after the experiment is disabled. Inspect the knob's rules when shipping a winner intended for every client.

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

The SDK sends a 64-bit XXHash64 assignment hash, never a raw subject. The
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
also enforces `mcpHttp.maxConcurrentRequests`, `mcpHttp.maxRequestBytes`, and
`mcpHttp.bodyTimeoutMs`, which drops a request whose body has not finished
arriving in time so it releases its concurrency slot.

`set_inspect_event` and `delete_inspect_event` update
`catalog.inspectEvents` for an existing project. Removing a name immediately
purges its retained volatile samples; aggregate event counts remain unchanged.

## Operations

### Readiness and external monitoring

Every server configuration must explicitly include:

```json
{
  "readiness": {
    "probeIntervalMs": 10000,
    "probeTimeoutMs": 50,
    "maxPersistenceLagMs": 60000
  }
}
```

The periodic SQLite probe commits a write while preserving application state.
Its result is cached; `/ready` performs no database writes. The probe has its own
bounded SQLite busy timeout and restores the normal busy-timeout setting.
The persistence check fails after a flush error until a successful drain, or
when dirty state reaches `maxPersistenceLagMs`. Capacity checks cover concurrent
sync handlers and each project's pending history limits. MCP readiness covers
the configured HTTP route's request capacity; it does not authenticate a remote
MCP client. Shutdown fails readiness
before draining. SQLite success follows the configured durability mode and does
not establish power-loss durability or guarantee space for future writes.

Run `wardx-monitor /absolute/path/to/monitor.json` as a separate supervised
process, preferably on another host so it can detect loss of the Wardx host.
Its configuration is separate from the server's operational configuration, is
closed-schema, and requires every field below:

```json
{
  "endpoint": "http://127.0.0.1:8787/ready",
  "intervalMs": 10000,
  "requestTimeoutMs": 2000,
  "maxResponseBytes": 4096,
  "failureThreshold": 3,
  "recoveryThreshold": 2,
  "webhookUrlEnvironmentVariable": "WARDX_ALERT_WEBHOOK_URL",
  "webhookTimeoutMs": 2000
}
```

Supply the webhook URL through the named environment variable. The monitor
uses bounded HTTP requests, rejects redirects, and posts
`{"type":"wardx.readiness","status":"degraded"}` after consecutive failures,
then `status: "recovered"` after consecutive successes. Initial healthy state
and unchanged states are silent. Failed webhook deliveries are retried on later
cycles without an accumulating queue; obsolete pending states are discarded.
Webhook receivers should handle duplicates after ambiguous network failures.
Monitor state is process-local, so a restart can notify a continuing outage
again. This monitor checks service health; business-metric thresholds and
experiment follow-up require separately defined policies.

### Backup and recovery

The recovery CLI requires a JSON configuration file, even when Wardx is started
from code. For that setup, serialize the complete startup configuration object
to a private JSON file (0600) for recovery, using an absolute `sqlite.path` that
points to the same database. Include the resolved settings and ingest credentials;
do not commit this file. The MCP bearer remains environment-provided. Recovery
does not execute your JavaScript configuration module or preserve a custom HTTPS
transport, so preserve your application entry point and TLS setup separately.

After draining and stopping the original server:

```bash
wardx-recovery backup /absolute/path/to/server.json /absolute/path/to/new-backup
wardx-recovery verify /absolute/path/to/new-backup
wardx-recovery restore /absolute/path/to/new-backup /absolute/path/to/new-restore
wardx-server /absolute/path/to/new-restore/config.json
```

In this checkout, invoke the same commands using
`node packages/server/src/ops/recovery-cli.js` and
`node packages/server/src/ops/monitor-cli.js` before installing the package.

Backup uses SQLite's snapshot API to include committed WAL state and produces
`config.json`, `state.sqlite`, and a SHA256 `manifest.json`. Directories are
private (0700), files are private (0600), and config contains the original
credentials. Keep the entire backup protected. Checksums detect corruption;
they do not authenticate a backup from an untrusted source.

Verification checks the manifest, file hashes, SQLite integrity and supported
schema, effective project configuration, historical row shapes, and persisted
JSON. Restore only accepts a new directory, verifies copied files, and points
storage inside it. Existing destinations are rejected and incomplete output is
retained for inspection. Neither command stops, starts, or overwrites the
original server. Environment-provided credentials such as the MCP bearer must
be supplied separately to the restored process.

The snapshot includes durable config/catalog/journal, historical aggregates,
and experiment evidence/decisions. Stop/drain is required to include accepted
in-memory history. Volatile recent-event/log/client rings and historical NDJSON
debug output are outside the backup. Schedule backup and `verify` with your
existing supervisor, and periodically restore to a fresh directory and exercise
the restored server. When rehearsing beside the original, use a separate copy
of the restored configuration with loopback/free ports and MCP HTTP disabled.
Do not edit the verified backup itself.

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
| `createWardxHandler(config)` | Create a request handler and explicit lifecycle for an application-owned transport. |
| `createIngestServer(config, { server? })` | Create Wardx on its HTTP server or a supplied Node server. |
| `listen(server, port, host)` | Listen and return the bound address. |
| `startServer(config, { server? })` | Create, listen, serve MCP HTTP on the same listener when enabled, and install signal shutdown. |
| `loadServerConfig(path)` | Read and strictly validate operational JSON. |
| `ControlService` | In-process MCP/control implementation. |
| `executeTool` | MCP tool dispatcher used by stdio and tests. |
| `FrameAggregator` | Current one-minute aggregation. |
| `NullSink`, `MemorySink`, `NdjsonSink` | Optional envelope debug sinks. |

Detailed wire and component contracts live in `docs/PROTOCOL.md` and
`docs/ARCHITECTURE.md`.

## Discard telemetry while keeping definitions

Stop every Wardx process using the database, then run:

```bash
wardx-recovery reset-data /absolute/path/to/state.sqlite
```

To preserve CPU and other numeric history while changing hash algorithms:

```bash
wardx-recovery reset-data /absolute/path/to/state.sqlite --hash-data-only
```

This removes only `distinct` rows from minute/hour/day history and clears user
retention and experiment exposures/goals, totals, and terminal results. It
preserves counters, gauges, histograms, event/log counts, bucket boundaries,
finalization, drop counts, and compaction watermarks. Empty buckets remain in
place. The result additionally reports `removedDistincts`, the number of sketch
rows removed across all history tiers. `removedRows` counts deleted SQLite rows
in the reset tables. Both modes preserve definitions and upgrade schemas 1/2/3 to
4 atomically; malformed historical JSON aborts the filtered reset with rollback.

Without `--hash-data-only`, the full reset behaves as follows.

This permanently clears historical aggregates, compaction watermarks, user
retention, experiment exposures/goals, totals, and terminal results for **all
projects** in that SQLite database. It preserves Remote Config values, metric
descriptions and the rest of the catalog, experiment definitions, project
versions, and the configuration mutation journal. Enabled experiments keep
their definitions and analysis dates; review their plans before collecting a
new sample.

The command accepts SQLite schemas 1, 2, 3, and 4 and recreates the empty telemetry
tables using the current XXHash64 schema in one transaction. Pass the database path used by the running application (`config.server.sqlite.path`
for a `createWardxSite` wrapper). It does not load configuration or credentials;
CJS, ESM, JSON, and programmatic setups use the same command. Relative paths
resolve against the command working directory. It never creates a missing
source database and fails immediately if another writer holds the SQLite lock. Failure
rolls back the database changes. The JSON result reports `removedRows` and
`schemaVersion`, without printing configuration contents.

Restart Wardx with the updated clients after completion. This is an offline
operation: an active server can retain old data in memory or write it back.
NDJSON diagnostics, external logs, and backups are not deleted by this command;
remove those separately if you also want to discard them. This is a logical
reset, not secure erasure of storage media.

## Persistent user retention

Node `retentionActivity(userId)` and C#/Unity `RetentionActivity(userId)` emit
explicit activity for D1/D7/D30 retention. Ordinary events, `identify`, session
IDs and HLL distinct metrics do not establish retention cohorts.

Node `retentionActivity(userId, { channel })` and C#/Unity
`RetentionActivity(userId, channel)` also name an acquisition channel. Node
`conversion(userId, goal)` and C#/Unity `Conversion(userId, goal)` record that
the user reached a goal such as `purchase`. Channels and goals are lowercase
labels matching `^[a-z0-9][a-z0-9._-]{0,63}$`; anything else is rejected with
HTTP 400. A conversion is not activity: an automatic renewal does not count as
a return.

Required centralized configuration:

```json
"retention": {
  "maxUsersPerProject": 1000000,
  "maxChannelsPerProject": 64,
  "maxGoalsPerProject": 16,
  "maxQueryDays": 366
}
```

`get_retention({ project, from, to })` reads cohorts in the half-open UTC date
range `[from, to)`, using `YYYY-MM-DD`. It includes the original cohort size
and exact received-user counts and rates (fractions 0–1) for activity **on**
D1/D7/D30. Return dates are independent of the query range. A day is `pending`
until its UTC midnight end, with null users/rate; empty cohorts are omitted.
`exact: true` describes counting accuracy and `basis: "received_activity"`
limits the claim to received activity, not delivery completeness.

### Acquisition channels and cohort conversion

Add `goal` to measure "of the users who arrived on day X, how many converted
within N days". Each cohort then carries `conversions` for D1/D7/D30 with the
same `day`, `status`, `users` and `rate` fields as `returns`, and the result
reports `conversionMode: "by_day"`. A conversion counts when the user's first
received conversion to that goal falls on or before cohort day + N, so the
series is cumulative, unlike `returns`. A conversion received before the user's
first activity counts from D0. Users who never report activity have no cohort
and do not appear. Conversion D_N is `pending` until the same UTC midnight as
the return for D_N.

Add `byChannel: true` to split each cohort by first-touch channel, or
`channel: "tiktok"` to keep one channel. Rows then carry `channel` and the
result reports `attribution: "first_touch"`. A user's channel is taken from
the earliest received activity that carries one; a later activity never
replaces it, and activity without a channel never clears it. Equal timestamps
resolve to the lowest label, so arrival order does not matter. `channel: null`
groups users with no channel-bearing activity yet. A user who receives a
channel later, for example from an attribution callback, moves to that channel.

```json
{ "project": "shop", "from": "2026-10-01", "to": "2026-10-15", "goal": "purchase", "byChannel": true }
```

This compares a new campaign with an old one by the conversion of its
cohorts, which a per-period `purchase` counter cannot do: a channel that
started last week has few sales in the period even when its cohorts convert
well.

Channel and goal labels are pinned per project and do not expire. Once a
project holds `maxChannelsPerProject` channels, a first touch that names a new
channel is ignored: the activity still counts, the user keeps their previous
channel or none, and `retentionChannelsDropped` in `/ready` increments with an
`ingest.retention_channel_capacity` diagnostic. Once it holds
`maxGoalsPerProject` goals, conversions to a new goal are dropped and
`retentionConversionsDropped` increments with an `ingest.retention_capacity`
diagnostic. A subject first seen through a conversion counts toward
`maxUsersPerProject`; at capacity, its conversion is dropped the same way.

Each project's first activity pins a fingerprint of the client's privacy salt.
All clients must keep that salt and user identity stable. A mismatched salt
returns HTTP 400. Roles and environments share the project's population; use
separate projects when those populations must not mix. The application defines
what counts as activity by where it calls the SDK method. Do not mix app-open
and gameplay definitions within the same project.

SQLite stores one salted subject hash, earliest activity UTC day and a 31-bit
activity mask per user, plus the first-touch channel and its timestamp, and the
earliest conversion UTC day per user and goal. The mask also preserves intermediate days so that an
earlier delayed activity can correct the cohort without losing D1/D7/D30
returns. Processing duplicates, different arrival orders and process restarts
does not double-count users. Queries expose no subject hashes. Counts can be
revised by delayed accepted activity even after a target day is mature.

User rows and salt fingerprints do not expire: forgetting an old user would
incorrectly enroll them again. Capacity is bounded by `maxUsersPerProject`.
At capacity, activity from new users is dropped instead of evicting old users;
existing users keep reporting activity and the rest of the envelope is accepted.
Each drop emits an `ingest.retention_capacity` diagnostic with the project and
count and increments `retentionActivityDropped` in `/ready`.
`maxQueryDays` bounds the query date span, and the user capacity bounds the
population scanned. Hashes are pseudonymous per-user state; account for this
in the deployment's data-retention policy. This feature adds no user-history
or per-user query API. Raw diagnostic sinks/allowlisted recent event inspection
can retain the hashed activity payload under their existing policies.

The SQLite schema is now version 4 and stores XXHash64 identities as 8-byte
values. On startup the server migrates a version 3 database in place, in one
transaction, by adding the channel, goal and conversion tables; existing users,
cohorts and every other table are kept. Backups of version 3 remain verifiable
and restorable. Versions 1 and 2 are rejected: they require fresh telemetry
history and a coordinated server and SDK upgrade. Use the offline `reset-data` command above to preserve configuration and
catalog definitions while discarding old telemetry, or create a fresh database.
No other migration or deletion is performed at server startup. External configuration files must include the
required `retention` object, including `maxChannelsPerProject` and
`maxGoalsPerProject`, before startup.

Accepted retention and experiment evidence commit in one SQLite transaction
before sync success. General telemetry persistence retains its existing
behavior. The SDK still has no durable outbox or same-batch retry: buffer drops,
failed requests and late-data rejection can bias cohorts and returns. Existing
`history.maxAcceptedPastAgeMs` and clock-skew settings apply to activity too.
D30 does not require 30-day-old incoming events; its initial cohort is already
persisted independently of aggregate history.
