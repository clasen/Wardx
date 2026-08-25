# Wardx architecture

Wardx is one bounded process with two interfaces. SDKs use HTTP sync; agents use
MCP stdio. There is no admin HTTP API and no supported multi-replica topology.
See `CLUSTER_ROADMAP.md` for work deliberately outside this contract.

```text
SDKs -- POST /v1/sync --+
                        v
                 wardx-server
                 |- bounded current aggregates and volatile rings
                 |- scoped credentials and role-filtered config replies
                 |- SQLite WAL authoritative state
                    |- Remote Config, catalog, journal
                    |- minute/hour/day aggregate tiers
                    |- experiment ledger, totals, terminal decisions
                        ^
Agent -- MCP stdio ------+
```

`@wardx/core` runs inside the SDK. Measurement calls perform no network or
filesystem I/O and create no Promises. Assignment and `config.get` also run on
the client. A sync uploads bounded frames and downloads only the configuration
visible to that SDK role.

## Projects, credentials, and trust

Projects are bootstrapped in the operational JSON config. Credentials are
records with a non-secret label, project, allowed roles, enabled flag, and
`trustedForDecisions`. The server authenticates the raw key before envelope
validation, then authorizes the claimed role from the credential record. A
credential cannot claim an undeclared role.

Public-client credentials must be untrusted. Experiment decisions use only
trusted rows emitted under the same deterministic assignment hash and preserve
source role plus trust class. Raw credentials and raw subject identifiers never
appear in diagnostics, MCP results, or mutation records. Remote Config is not a
secret store even when a key is routed only to a backend role.

## Durable state and history

The operational JSON contains process settings, credentials, and the initial
project bootstrap. On an empty database the bootstrap is written once. From
then on, the local SQLite database at `sqlite.path` is authoritative for project
state. Wardx uses WAL mode and configured synchronous, busy timeout,
auto-checkpoint, checkpoint mode, batch, transaction, and queue bounds. A
general-purpose network filesystem is unsupported.

Open aggregates stay in memory. General telemetry marks coalesced historical
state and does not perform a SQLite transaction per sync. Closed one-minute
buckets are written to SQLite, compacted deterministically to hour and day, and
pruned only after the downstream rollup and its watermark are durable. Hour/day
rows keep project, role, environment, app version, signal name, and declared
dimensions. They never keep event or log attrs, histogram exemplars, instance
IDs, or subject hashes.

`get_aggregates` returns current in-memory windows. `get_aggregate_history`
returns bounded hour/day ranges with optional role, environment, app-version,
and exact-name filters plus completeness metadata. Recent clients and recent
logs are bounded volatile rings and are empty after restart.

## Control plane

Every catalog, config, and experiment mutation requires the current
`expectedVersion` and a non-empty `reason`. The mutation and its bounded journal
entry commit in one SQLite transaction before the in-memory snapshot is
published. A stale version returns a conflict without changing state or the
journal. `list_config_changes` returns bounded public metadata;
`rollback_config_change` applies a retained inverse as a new version. It never
rewrites history or exposes reversible values in overview responses.

MCP client identity is recorded only when available; the current stdio boundary
does not invent a verified identity. MCP reads have configured concurrent and
pending bounds. Config changes remain administrative operations protected by
stdio and filesystem access; Wardx does not add RBAC or approval workflows.

## Experiments

An experiment always declares `assignmentUnitKind`, `goalMetric`, and
`terminalRetentionMs`. A closable experiment additionally pre-registers its
complete fixed-horizon plan: outcome kind, control, target sample size per
variant, earliest analysis time, family-wise alpha, minimum effect, direction,
and every evidence-health threshold.

The SDK emits a SHA-256 assignment hash, never the raw unit. The SQLite ledger
accepts the first exposure and first matching goal for each project,
experiment, and 256-bit hash. Duplicate exposures/goals, conflicting goals,
variant conflicts, missing exposures, untrusted rows, and late rows are counted
without changing accepted totals. Exposure and goal provenance must match.

Before both time and sample horizons, analysis is descriptive and
`collecting`. At the horizon it uses trusted deduplicated evidence, Newcombe/
Wilson conversion intervals or Welch inference for means, and Holm correction
across treatments. The first terminal input and result are persisted and later
telemetry cannot flip them. Shipping requires a persisted healthy terminal
winner, matching `expectedVersion`, and a reason. Disablement or terminal
analysis schedules ledger expiry; a pruned experiment with prior totals cannot
be resumed under the old ID.

## Capacity and failure behavior

Sync handlers, pending historical batches/bytes, experiment ledger rows, MCP
reads, current series, rings, query ranges, and retained tiers are all bounded by
required configuration. Above those limits Wardx rejects work with a
non-sensitive overload response instead of building an unbounded queue. Clients
and proxies must not retry `POST /v1/sync`; general telemetry remains
at-most-once. Experiment evidence is the narrow exception: accepted evidence is
committed transactionally before the sync succeeds.

`GET /health` is liveness only. Graceful shutdown stops HTTP, drains accepted
dirty history, runs the configured checkpoint, and closes SQLite. Local disk,
proxy behavior, production hardware, and the published 5,000 sync/s target must
be proven separately with the full-feature stress profile; deterministic tests
do not establish deployment capacity.

## Instrumentation boundary

Wardx is aggregate-first. Use counters/histograms for stability, a small set of
named events for behavior, and recent logs for drill-down. Funnels are volume
comparisons, not per-subject paths. The experiment assignment ledger is
non-queryable and exists only for deduplication. Wardx is not a raw event
warehouse, billing ledger, player journey store, or authoritative economy
database.

Protocol details and HTTP status semantics are in [PROTOCOL.md](PROTOCOL.md).
