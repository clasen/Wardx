---
name: wardx-server
description: Operate or change the Wardx single-process ingest, historical aggregate, Remote Config, experiment, trust, and MCP control plane. Use for wardx-server, @wardx/server, get_aggregate_history, safe config mutations, fixed-horizon experiments, or packages/server work. Use an SDK-specific skill for application instrumentation.
---

# Wardx server

Wardx has two application surfaces in one bounded process: clients use
`POST /v1/sync`; agents use MCP over stdio or optional loopback-only Streamable
HTTP. There is no admin REST API or supported multi-replica mode.

Read [references/tools.md](references/tools.md) for exact MCP arguments. When
editing the server, also read [references/package.md](references/package.md).

## Start an MCP investigation

1. `list_projects`, then `get_project_overview` or
   `wardx://project/{name}`.
2. If `overview.onboarding.complete` is false, ask only for its listed missing
   project, role, knob, and outcome descriptions. Persist them with the matching
   catalog mutation using the overview's current version and a reason.
3. Use `get_aggregates` for current windows and `get_aggregate_history` for
   bounded hour/day baselines. Filter by role when comparing product surfaces.
4. Use `get_recent_events` or `get_recent_logs` only to drill into current
   sample rows. Recent events must first be enabled by `catalog.inspectEvents`.
   These tools expose raw attrs (and recent events expose `instanceId`), are
   bounded volatile rings, and are not history searches.

Never invent catalog descriptions, paths, git URLs, identities, or trust.
Remote Config never contains secrets.

For remote MCP, keep `mcpHttp.host` on loopback, supply the named bearer token
through the environment, and reach it through an SSH local-forward. Host,
optional Origin, request size, and concurrency are strict configured bounds.
Never expose the listener directly or store its token in JSON.

## Mutations

Every catalog/config/experiment mutation requires current `expectedVersion` and
a non-empty `reason`. On conflict, re-read state and reconsider the change; do
not blindly retry. Catalog mutations also advance the project version.

Use `list_config_changes` for retained audit metadata. Use
`rollback_config_change` to apply a retained inverse as a new version. Rollback
never decrements a version or rewrites the journal.

## Experiments

Propose only over existing knobs visible to every `experiment.roles` entry.
Every experiment requires `assignmentUnitKind`, `goalMetric`, and
`terminalRetentionMs`. A descriptive experiment omits every terminal-policy
field. A closable experiment declares all of:

- `outcomeKind`: `conversion` or `mean`;
- `control`, `targetSampleSizePerVariant`, `earliestAnalysisAt`;
- `familyWiseAlpha`, `minimumEffect`, `direction`;
- all `healthThresholds` fields listed in the tool schema.

Assignment remains client-side. The server's non-queryable SHA-256 ledger
deduplicates assignment units and preserves source role/trust. A trusted goal
must match a trusted exposure with the same assignment hash and provenance.

`analyze_experiment.variants` is trusted decision evidence;
`telemetryVariants` includes all provenance. Before both horizons the status is
`collecting`. Terminal results are durable: `winner`, `no_difference`,
`inconclusive`, or `invalid`. Do not declare or ship a winner unless the
persisted decision is a healthy `winner`. `ship_experiment` also needs current
`expectedVersion` and a reason.

Do not change salt, variants, roles, goal, assignment unit, or analysis policy
after the first trusted exposure. Disablement may be resumed only with the same
plan before ledger retention expires. A shipped or expired plan needs a new ID.

## Telemetry interpretation

- Counters are deltas summed per bucket.
- Current gauges are latest-by-timestamp; historical gauges also expose
  min/max/sample count.
- Events are historical counts by name without attrs. `get_recent_events` is an
  allowlisted, bounded memory-only sample containing raw attrs and instance IDs.
- Historical allowlisted logs are counts by role/level/name without attrs.
- Historical histograms merge only identical bounds and never retain exemplars.
- Distinct rows merge HLL registers across workers and buckets; reads expose
  only `estimate` and `precision`, never identifiers or raw registers.
- Funnels are volume comparisons, not unique users or ordered journeys.
- The experiment ledger is not queryable subject history.

Historical results retain role, environment, app version, signal, and declared
dimensions. They never contain attrs, exemplars, instance IDs, raw credentials,
or subject hashes.

## Trust and production boundary

Credentials declare project, allowed roles, enabled state, and
`trustedForDecisions`. Public clients are untrusted. A role outside the
credential allowlist is rejected before mutation. Never expose raw keys in
diagnostics or MCP.

Run one process against one local SQLite WAL database. Do not share the file or
put it on NFS. `createIngestServer(config, { server })` and
`startServer(config, { server })` accept a dedicated Node HTTP-compatible server
created by the application, including `https.createServer({ key, cert })`. It
must not already have a `request` listener; Wardx owns request handling and
closes it during `server.wardx.stop()`.

Keep HTTP behind a proxy with TLS and measured body/rate/connection limits when
those controls are not supplied by the deployment; never retry
`POST /v1/sync`. `GET /health` is liveness only. Back up the operational
configuration source plus SQLite after graceful drain/stop.

Capacity bounds reject excess sync handlers, pending historical batches/bytes,
ledger rows, MCP reads, series, and query ranges. A 5,000 sync/s figure is a
release target, not proof; cite it only with full-feature stress output,
hardware, settings, duration, commit, and local-SSD details.

## Troubleshooting

- `unknown project`: use the name from `list_projects`, never the raw key.
- `version conflict`: re-read the project; the error includes current version.
- `role not allowed`: use a credential scoped for that role.
- `not ready to ship`: collect trusted evidence or fix the reported horizon/
  health failure; never bypass with manual config edits.
- empty history: check tier/range/finalization and current versus historical
  tool choice.
- no tools: for local operation, configure the MCP client to spawn
  `wardx-server <config.json>` on stdio. For remote operation, check the SSH
  tunnel and configure Streamable HTTP at its local endpoint; do not substitute
  an HTTP admin call.
