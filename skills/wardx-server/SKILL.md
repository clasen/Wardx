---
name: wardx-server
description: Integrate, operate, or modify @wardx/server, including HTTP/HTTPS handlers, lifecycle, MCP investigations, historical telemetry, retention, Remote Config, and experiments. Use for Wardx server work; use an SDK-specific skill for application instrumentation.
---

# Wardx server

Wardx has two application surfaces in one bounded process: clients use
`POST /v1/sync`; agents use MCP over stdio or optional loopback-only Streamable
HTTP. There is no admin REST API or supported multi-replica mode.

Read only the reference relevant to the task:

- [references/package.md](references/package.md): programmatic integration,
  handler/server lifecycle, configuration, internals, and verification.
- [references/tools.md](references/tools.md): MCP arguments, retention semantics,
  config constraints, conditional rules, and experiment policy fields.

For a framework-owned HTTP/HTTPS transport, use `createWardxHandler(config)`
and retain its `stop` function. Use `startServer` when Wardx should own listeners
and process signals. Check the installed package exports before using a new API;
repository documentation can precede an npm release.

## Start an MCP investigation

1. `list_projects`, then `get_project_overview` or
   `wardx://project/{name}`.
2. If `overview.onboarding.complete` is false, ask only for its listed missing
   project, role, knob, and outcome descriptions. Persist supplied descriptions
   only when catalog changes are authorized, using the current version and a reason.
3. Use `get_aggregates` for current windows and `get_aggregate_history` for
   bounded hour/day baselines. Filter by role when comparing product surfaces,
   and by catalog category when comparing signal purposes.
4. Use `get_recent_events` or `get_recent_logs` only to drill into current
   sample rows. Recent events must first be enabled by `catalog.inspectEvents`.
   These tools expose raw attrs (and recent events expose `instanceId`), are
   bounded volatile rings, and are not history searches.

Never invent catalog descriptions, paths, git URLs, identities, or trust.
Remote Config never contains secrets.

Signal categories are optional exact open names such as `business`,
`performance`, `reliability`, or `security`. They live in the catalog and are
not metric dimensions. Use the overview's `categories` list before filtering.

For remote MCP, keep `mcpHttp.host` on loopback, supply the named bearer token
through the environment, and reach it through an SSH local-forward. Host,
optional Origin, request size, and concurrency are strict configured bounds.
Never expose the listener directly or store its token in JSON.

## Mutations

A read-only investigation does not authorize catalog/config/experiment changes.
Every authorized mutation requires current `expectedVersion` and
a non-empty `reason`. On conflict, re-read state and reconsider the change; do
not blindly retry. Catalog mutations also advance the project version.

Use `list_config_changes` for retained audit metadata. Use
`rollback_config_change` to apply a retained inverse as a new version. Rollback
never decrements a version or rewrites the journal.

## Conditional Remote Config

Keys and experiments remain scoped by role. Knobs are adjustable config keys;
ordered rules choose each visible key's base value using client metadata and
application-defined attributes. Keep role separate from OS/build/channel;
`platform` identifies the SDK runtime. Do not hardcode update or platform logic
in Wardx. Read the tools reference before writing conditions.

Inspect a knob's current rules before tuning it. `set_config_value` preserves
rules when omitted and clears them with `[]`. Conditions do not change experiment
eligibility or assignment: an applicable variant overrides the resolved base.
`ship_experiment` writes the winner to the base and preserves rules, which apply
again after disablement. Account for them when a winner should reach all clients.

## Experiments

Propose only over existing knobs visible to every `experiment.roles` entry.
Every experiment requires `assignmentUnitKind`, `goalMetric`, and
`terminalRetentionMs`. Descriptive and closable plans have different policy
requirements; use the all-or-none schema in the tools reference.

Assignment remains client-side. The server's non-queryable XXHash64 ledger
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

Run one process against one local SQLite WAL database; do not share the file or
put it on NFS. Starting, restarting, deploying, or exercising production requires
explicit authorization. Follow existing authorization rather than requesting it
again. Use the package reference to assign transport and shutdown ownership.

Keep HTTP behind a proxy with TLS and measured body/rate/connection limits when
those controls are not supplied by the deployment; never retry
`POST /v1/sync`. `GET /health` is liveness only; use `/ready` for operational
readiness. Back up the operational
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

## Persistent retention

Use `get_retention` for explicit activity cohorts and exact received-user
D1/D7/D30 counts; events and HLL metrics cannot backfill cohorts. Read its UTC
range, pending-day, and late-arrival semantics in the tools reference before
interpreting results. Retention is project-wide, not filtered by role or
environment. Check storage/configuration constraints in the package reference
when integrating activity collection or changing a deployment.
