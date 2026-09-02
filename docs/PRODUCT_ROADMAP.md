# Wardx product roadmap

**Status:** implemented

**Created:** 2026-08-24

**Goal:** define and implement Wardx's initial single-process product with useful
historical context, defensible experiment decisions, minimal trust and mutation
controls, and proven high-demand capacity on one server

This roadmap turns the first three product limits recorded in
[HARDENING_ROADMAP.md](HARDENING_ROADMAP.md) into the initial implementation
plan. It establishes Wardx's defining shape: aggregate-first telemetry, a minimal
SDK hot path, HTTP sync for clients, and MCP for agent analysis and control.
Multi-replica operation and failover are deferred to
[CLUSTER_ROADMAP.md](CLUSTER_ROADMAP.md).

## Outcome

When this roadmap is complete, an agent can:

1. compare current behavior with hourly and daily aggregate baselines;
2. declare and ship an experiment winner only under a pre-registered,
   fixed-horizon decision policy over deduplicated assignment units;
3. distinguish trusted from untrusted telemetry and change Remote Config with
   optimistic concurrency, a durable change record, and rollback;
4. serve the declared high-demand workload on one bounded process without
   unbounded queues, memory, disk, or event-loop delay.

## Non-goals

This roadmap does not add:

- raw event history or a general event warehouse;
- user journeys, per-account queries, cohorts, or retention analytics;
- a billing ledger or authoritative game-economy store;
- arbitrary SQL through MCP;
- an HTTP admin API, dashboard, or approval UI;
- horizontal ingest replicas, leader election, multi-host replication, or
  automatic failover;
- migration, import, or compatibility paths for pre-existing Wardx deployments;
- automatic scheduling of a later agent run.

Cluster mode is not a prerequisite for a production Wardx deployment. It is an
optional future response to a measured availability or capacity requirement, not
the default way to obtain acceptable performance.

Opaque hashed assignment-unit state required to deduplicate an active experiment
is a narrow exception to the no-per-subject-storage rule. It is not queryable as
a journey, contains no raw subject identifier, and expires after the experiment's
declared terminal-retention period.

## Engineering constraints

- The application remains more important than telemetry. Measure calls do no
  network or filesystem I/O and do not create Promises.
- General telemetry is at-most-once. A reliability guarantee for experiment
  evidence must be designed explicitly; it cannot be inferred from the general
  transport.
- All retention, capacity, timing, and policy values live in centralized
  configuration. Every setting is required and has no fallback default.
- Public MCP schemas, SDK options, wire envelopes, server configuration, and
  persisted formats are initial contracts defined before implementation. There
  is no legacy Wardx contract or persisted state to support.
- No dependency is added until its purpose, maintenance cost, and supported
  runtime matrix are approved.
- One `wardx-server` process is the supported deployment topology in this
  roadmap. Scale up and optimize measured bottlenecks before considering scale
  out.
- SQLite is local to that server. A shared `.sqlite` file on NFS or another
  general-purpose network filesystem is not supported.
- Every capability claim must point to deterministic tests. Proxy, local disk,
  network, hardware, and production capacity remain separate external proof
  boundaries.

## Dependency order

```text
Phase 0: contracts
    |
    +--> Phase 1: local durable store and historical aggregate model
    |        |
    |        +--> Phase 2: historical queries and retention
    |
    +--> Phase 3: minimal trust and safe mutations
             |
             +--> Phase 4: experiment evidence and decisions
             |
             +--> Phase 5: single-node capacity and release proof
```

Automatic experiment shipping must not ship until both Phase 3 and Phase 4 are
complete. Every milestone must keep the single-node capacity gate green.

## Phase 0: approve the contracts

These decisions define the initial public and persisted contracts. Record the
approved result in `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, package READMEs,
and the relevant skills before implementation.

### HIST-DEC-1: historical tiers

Recommended contract:

- Use 1-minute windows for operational drill-down.
- Produce closed hourly rollups with required
  `aggregateHourlyRetentionHours`.
- Produce closed daily rollups with required `aggregateDailyRetentionDays`.
- Group historical series by project, role, environment, app version, signal
  name, and declared low-cardinality dimensions.
- Enforce an explicit cap for app versions per project/role/tier. Reject or count a
  new over-cap historical series; never silently merge it into an invented
  version.
- Do not retain event attrs, log attrs, histogram exemplars, instance IDs, or
  subject hashes in hourly or daily rollups.

The exact retention values are operator policy, not constants in code.

### HIST-DEC-2: closed-window and late-data policy

Recommended contract:

- A minute becomes compactable only after its end plus the configured clock-skew
  allowance.
- Require a maximum accepted past age for frame timestamps. Data older
  than that boundary is rejected before state mutation and counted in local
  diagnostics.
- Recompute an open hourly/daily bucket deterministically from its contributing
  lower tier. Finalized buckets are immutable.
- Persist compaction watermarks so restart cannot double count a minute.

### EXP-DEC-1: assignment unit and goal semantics

Recommended contract:

- One experiment declares one assignment-unit kind and one `goalMetric`.
- The same stable assignment-unit identifier drives assignment, exposure, and
  goal deduplication.
- A conversion experiment accepts at most one goal per assignment unit.
- A quantitative-mean experiment accepts at most one value per assignment unit.
  A session-level experiment therefore uses a session identifier as its unit,
  not a reusable account identifier.
- The first accepted goal is authoritative. Duplicate or conflicting goals are
  ignored and counted separately; they never alter totals silently.
- Experiment salt, variants, roles, goal, assignment-unit policy, and analysis
  policy become immutable once enabled. A changed hypothesis uses a new
  experiment ID.

### EXP-DEC-2: statistical policy

Recommended first contract: fixed-horizon inference only.

Each closable experiment declares before enablement:

- control variant;
- outcome kind: conversion or mean;
- target sample size per variant;
- earliest terminal-analysis timestamp;
- family-wise alpha;
- minimum effect of interest;
- expected direction: increase, decrease, or two-sided;
- terminal retention for the deduplication ledger.

`analyze_experiment` may show descriptive progress at any time, but it cannot
return `winner` before both the time and sample horizon are satisfied. The first
terminal analysis is persisted and never recomputed from later arrivals.

Use Wilson/Newcombe-style intervals for conversion differences, Welch inference
for means, and Holm correction when several treatments are compared with one
control. A sequential test may be designed later as a separate policy; repeatedly
applying a fixed-confidence interval is not a sequential test.

### TRUST-DEC-1: credentials and trusted evidence

Recommended minimal contract:

- Define credential records containing project, allowed roles, and
  `trustedForDecisions` as the only credential schema.
- A credential cannot submit a role outside its allowlist.
- Public-client credentials are untrusted even when role-scoped.
- Experiment totals preserve source role and trust classification.
- `ship_experiment` refuses a decision based on untrusted evidence. A
  backend-verifiable outcome must be emitted by a trusted role using the same
  deterministic assignment unit.
- No credential, raw key, or subject identifier appears in MCP output,
  diagnostics, or audit records.

### CTRL-DEC-1: minimal mutation safety

Recommended minimal contract:

- Every config or experiment mutation requires `expectedVersion`.
- Version mismatch fails without persistence or in-memory mutation and returns
  the current version.
- Every mutation requires a non-empty reason. The MCP client identity is captured
  when available; an absent unverifiable identity is recorded as such rather than
  invented.
- The authoritative config stores a bounded, append-only-within-retention change
  journal in the same atomic commit as the mutation. Its required capacity is a
  centralized setting.
- A rollback creates a new version by applying the inverse of a retained change;
  it never rewrites history or decrements the version.
- Audit values remain protected with the server config and are not included in
  normal overview responses.

This minimal phase does not add RBAC, human approvals, a web UI, or multi-party
authorization. MCP stdio/filesystem access and the optional loopback-only MCP
HTTP bearer reached through an SSH tunnel remain the administrative trust
boundaries.

### STORE-DEC-1: local durable store

Recommended contract: one local SQLite database in WAL mode becomes the
authoritative store for Remote Config, catalog, mutation journal, experiment
assignment-unit state, experiment totals, minute/hour/day aggregates, and
compaction watermarks.

The operational JSON file stores process settings and credential material.
SQLite starts empty and is the only authoritative application-state store from
the first implementation; there is no import, dual-write, or legacy file
fallback.

WAL mode, synchronous durability, busy timeout, checkpoint policy, maximum write
batch, and transaction timeout are required centralized settings. The SQLite
driver requires explicit dependency approval before implementation.

## Phase 1: local durable store and historical aggregate model

### STORE-1: transactional SQLite repository

Implement SQLite behind the concrete state boundaries defined by this roadmap:

- Remote Config and catalog;
- mutation journal;
- minute/hour/day aggregates and compaction watermarks;
- experiment assignment-unit ledger, totals, and terminal decisions.

Open aggregates remain in memory. Ingest submits bounded coalesced batches; it
does not perform one SQLite transaction per sync request. Config mutation and its
journal entry commit in one transaction.

Verification:

- Startup creates the initial schema in an empty database and rejects an
  incompatible schema or failed initialization.
- Config, journal, aggregate, and experiment writes are atomic at their declared
  transaction boundary.
- WAL checkpoints and busy/timeout failures are observable and bounded.
- No request handler waits behind an unbounded SQLite writer queue.
- Clean shutdown drains accepted dirty batches and checkpoints according to the
  configured policy.

### HIST-1: define tier-neutral rows

Create one canonical internal representation for a closed aggregate bucket.

Required merge semantics:

| Signal | Historical value |
| --- | --- |
| Counter | Sum of deltas. |
| Named event | Count. No attrs. |
| Allowlisted log | Count by role, level, and name. No exemplar. |
| Gauge | Last value/timestamp plus min, max, and sample count. |
| Histogram | Merged count, sum, min, max, and compatible buckets. No exemplar. |
| Internal drops | Counters retained like other counters. |

Reject incompatible histogram bounds for the same historical series. Do not
merge them approximately.

Implementation areas:

- `packages/server/src/aggregation/`
- `packages/server/src/control/persist.js`
- `packages/server/src/loadConfig.js`
- `config/development.json`
- `config/production.json`

Verification:

- Merge results are independent of input order.
- Re-merging the same closed source bucket is idempotent.
- Hour and day boundaries use UTC and survive daylight-saving changes.
- Counter, gauge, histogram, event, log, role, environment, and app-version
  fixtures round-trip through persistence.
- Historical rows contain none of the prohibited attrs or identifiers.

### HIST-2: compact minute to hour and hour to day

Implement a compactor that operates only on closed source buckets and advances a
persisted watermark after the destination write succeeds.

Requirements:

- At most one compaction is in flight per project and tier in single-process
  mode.
- Source expiry cannot run ahead of successful destination compaction.
- A crash between destination write and watermark publication cannot double
  count after restart.
- A late but still accepted source update recomputes the open destination bucket.
- Finalized buckets are immutable and bounded by their configured retention.
- Graceful shutdown flushes dirty destination buckets and watermarks.

Verification:

- Restart at every write boundary produces the same final rollup.
- Retention prunes exactly at the configured boundary.
- Disk-full and permission failures preserve source data and dirty state.
- A multi-day synthetic fixture matches a separately calculated golden result.

## Phase 2: historical MCP queries

### HIST-3: add `get_aggregate_history`

Define `get_aggregate_history` as a separate MCP tool. `get_aggregates` is limited
to current aggregates.

Recommended inputs:

- `project`;
- `tier`: `hour` or `day`;
- required bounded `from` and `to`;
- optional `role`, `environment`, `appVersion`, and exact `names` filters.

The response returns bucket boundaries, matching rows, catalog descriptions, and
completeness metadata: finalized/open status, drop counts, and the newest compacted
source watermark. It never returns raw rows or subject-level data.

Verification:

- Queries cannot exceed a configured bucket/row response limit.
- Role, environment, app-version, name, and time filters compose correctly.
- The MCP overview links to available history without embedding an unbounded
  history payload.
- Black-box restart proves that an agent can compare two completed days.

### HIST-4: performance and capacity gate

Define a persistence stress profile with realistic hourly/daily state.

Measure:

- ingest throughput and p99 during compaction;
- compaction latency and event-loop delay;
- source and destination write counts;
- RSS and disk growth by tier;
- query latency at maximum supported range;
- restart hydration time.

No retention recommendation may be published without the exact hardware,
cardinality, project count, tier configuration, and measured output.

## Phase 3: minimal trust and safe mutations

### TRUST-1: enforce credential role scopes

Resolve the credential before envelope validation and pass its trusted server-side
metadata into ingest. Never trust a wire field for source trust.

Verification:

- A frontend credential cannot claim a backend role.
- A multi-role credential can claim only its declared roles.
- Unknown, disabled, and rotated credentials fail without state mutation.
- Logs and diagnostics identify a non-secret credential label, never the key.
- Node and C# SDK fixtures accept valid role-scoped credentials.

### TRUST-2: retain experiment evidence provenance

Key experiment totals by experiment, variant, source role, and trust class. Keep
the aggregate overview bounded and simple, but make `analyze_experiment` disclose
which evidence is eligible for a decision.

Verification:

- Untrusted and trusted rows never merge into one decision sample.
- Untrusted telemetry remains visible as product telemetry.
- A decision with no trusted eligible sample stays `cannot_decide`.
- A public client cannot make `ship_experiment` succeed by claiming a trusted
  role.

### CTRL-1: optimistic concurrency

Require `expectedVersion` for:

- `set_config_value`;
- `delete_config_value`;
- `upsert_experiment`;
- `set_experiment_enabled`;
- `ship_experiment`;
- the rollback operation.

Read-only tools do not require `expectedVersion`. Catalog-only mutations use a
separate catalog revision or an explicit expected config/catalog revision
contract; they must not silently bypass concurrency protection.

Verification:

- Two writers using the same version produce one success and one conflict.
- A conflict changes neither config, catalog, experiment state, nor journal.
- Persistence failure publishes neither the change nor its journal entry.
- Clients receive exactly one new version after a successful mutation.

### CTRL-2: durable journal and rollback

Each retained entry records timestamp, project, previous version, new version,
operation, affected names, reason, available client identity, and the reversible
change data. Secret credentials and subject identifiers are prohibited.

Define MCP tools:

- `list_config_changes` with bounded pagination;
- `rollback_config_change` with project, retained change ID, expected version,
  and reason.

Verification:

- Every successful mutation has exactly one matching journal entry.
- Rollback creates a new version and a new journal entry.
- A rollback conflict is non-mutating.
- Restart preserves both changed config and rollback ability.
- Journal retention removes only entries older than the configured capacity and
  reports the oldest available version.

## Phase 4: defensible experiment decisions

### EXP-1: active assignment-unit ledger

Persist a non-queryable ledger keyed by project, experiment, and 256-bit hashed
assignment unit. Store variant, first accepted exposure, optional first accepted
goal value, source role, trust class, and terminal-expiry metadata.

Requirements:

- The raw assignment-unit ID never reaches the server.
- Variant mismatch for the same hash is a validation failure and diagnostic.
- Duplicate exposure and duplicate goal are counted but do not change totals.
- A valid goal may establish its implied exposure only under the approved
  protocol contract; otherwise it is rejected. The chosen rule must be identical
  in Node and C# fixtures.
- Closing or abandoning an experiment schedules ledger deletion after its
  declared terminal retention.
- Capacity is explicit and enforced before accepting an experiment whose plan
  cannot fit.

Verification:

- Repeated goals cannot produce a conversion rate above one.
- SDK restart, duplicate frames, and bounded client-state eviction do not duplicate
  one assignment unit on the server.
- Known assignment-hash collisions do not collide in the 256-bit ledger key.
- Ledger state survives restart and disappears only at the declared expiry.

### EXP-2: immutable experiment plan

Validate the complete fixed-horizon analysis plan before enabling an experiment.
After the first accepted trusted exposure, policy and assignment fields are
immutable. Disablement may stop allocation, but changing the hypothesis requires
a new ID.

Verification:

- Invalid or underpowered plans are rejected before clients receive them.
- An enabled experiment cannot change salt, weights, values, goal, unit, horizon,
  direction, or alpha in place.
- A disabled experiment can be resumed only under the documented unchanged-plan
  rule.
- Cross-runtime assignment fixtures remain stable for an unchanged plan.

### EXP-3: fixed-horizon terminal analysis

Implement fixed-horizon terminal analysis for closable experiments. Do not
introduce a repeated normal-interval winner rule.

Requirements:

- Before the horizon, return descriptive progress and `collecting` only.
- At the horizon, analyze trusted deduplicated assignment units once.
- Apply the declared direction and family-wise correction.
- Persist the terminal input watermark, method version, comparisons, and decision.
- Later telemetry cannot flip the terminal result.
- `ship_experiment` accepts only a persisted terminal `winner`, the matching
  `expectedVersion`, and healthy experiment-evidence diagnostics.
- `no_difference`, `inconclusive`, `invalid`, and `winner` are distinct terminal
  outcomes.

Verification:

- Golden conversion and mean fixtures match an independent statistical
  implementation within declared tolerance.
- Null-effect simulations keep the empirical false-positive rate within the
  declared test tolerance.
- Multiple-treatment fixtures apply Holm correction correctly.
- Repeated progress reads cannot create an early winner.
- A terminal result is identical after restart.

### EXP-4: evidence health gates

Expose experiment-specific counts for dropped frames, rejected duplicates,
variant conflicts, untrusted rows, late rows, and missing/implicit exposures.

`ship_experiment` refuses when a configured health threshold is violated. Health
thresholds are required experiment policy, not hidden defaults.

## Phase 5: single-node high-demand capacity

One server must meet its declared capacity with SQLite durability, historical
compaction, trusted experiment evidence, diagnostics, and MCP reads enabled.

### PERF-1: define the supported workload

Record a reproducible capacity profile before optimizing:

- syncs per second and burst duration;
- logical clients at the configured sync interval and jitter;
- compressed and decoded envelope sizes;
- frames, metric rows, event rows, and log rows per sync;
- project, role, signal, dimension, app-version, and experiment cardinality;
- historical retention and compaction cadence;
- concurrent MCP reads and control mutations;
- SQLite durability and checkpoint settings;
- reference hardware and local SSD characteristics.

The initial minimum release target is 5,000 sync/s. At a 15-second average sync
interval, this represents 75,000 continuously syncing logical clients before
burst and safety headroom; client count alone is not a complete workload
description. A different target requires an approved profile change.

### PERF-2: keep ingest independent from disk latency

Requirements:

- HTTP validation and in-memory aggregation remain bounded.
- Ingest marks bounded dirty state and returns without one SQLite transaction per
  request.
- One coalescing writer drains prepared batches with an explicit maximum queue.
- Historical compaction operates on closed buckets and yields to ingest.
- MCP history queries use bounded ranges and cannot monopolize the writer.
- WAL checkpoint work is scheduled and measured; it never occurs accidentally on
  the measurement hot path.
- Worker threads or a dedicated compactor process are introduced only if measured
  serialization, compression, SQLite, or compaction work misses the event-loop
  gate.

### PERF-3: explicit overload behavior

When the declared capacity is exceeded, Wardx protects the host instead of
building an unbounded queue.

Define and verify:

- maximum concurrent sync handlers;
- maximum pending SQLite batches and bytes;
- maximum concurrent/pending MCP reads;
- proxy request-rate and connection limits;
- non-sensitive overload responses;
- local diagnostics and `wardx.internal.*` accounting for rejected or dropped
  work;
- recovery after the burst without restart or permanently dirty state.

Do not add automatic request retries: clients remain at-most-once and proxies must
not retry `POST /v1/sync`.

### PERF-4: full-feature stress and soak gates

Create `packages/stress` profiles for:

- steady-state release load with all new features active;
- a declared burst above steady state;
- growing historical tiers at maximum supported cardinality;
- simultaneous experiment ledger writes and MCP history reads;
- forced WAL checkpoints and representative local disk latency;
- restart after a dirty shutdown and bounded recovery;
- a scheduled long soak that detects RSS, WAL, disk, queue, and event-loop growth.

Report at minimum:

- actual sync/s and HTTP error rate;
- p50/p95/p99 HTTP latency;
- event-loop p50/p99;
- CPU and RSS start/peak/growth;
- pending writer batches/bytes and maximum queue age;
- SQLite transaction, busy, fsync, WAL, and checkpoint metrics;
- compaction lag and historical query latency;
- disk growth by data source;
- recovery time after burst and restart.

Every gate exits non-zero on a missed threshold. Publish no high-demand claim
without the exact commit, Node/SQLite versions, settings, hardware, workload,
duration, and full output.

### REL-1: complete release gate

The initial `npm run verify` gate includes deterministic SQLite initialization,
history, trust, concurrency, rollback, and experiment fixtures. The initial
`npm run verify:release` gate includes the full-feature sustained and burst
profiles. Keep the longer soak in a scheduled required workflow.

The package check installs released artifacts, initializes an empty SQLite
database, launches the packaged server, creates state through its supported
interfaces, exercises ingest and MCP, restarts it, and proves historical and
terminal experiment state survived without resolving monorepo sources.

## Milestones

### Milestone A: useful historical context

Complete STORE-DEC-1, STORE-1, HIST-DEC-1, HIST-DEC-2, and HIST-1 through HIST-4.

Exit criteria:

- An agent can compare two completed days through MCP.
- No historical tier stores raw attrs, exemplars, instance IDs, or subject hashes.
- Restart and compaction failures cannot double count or discard uncompacted
  source windows.
- Single-process ingest remains inside its declared performance gate.

### Milestone B: minimally safe control plane

Complete TRUST-DEC-1, CTRL-DEC-1, and TRUST-1 through CTRL-2.

Exit criteria:

- Credentials cannot claim undeclared roles.
- Trusted and untrusted experiment evidence remain separate.
- Concurrent mutations cannot silently overwrite each other.
- Every successful mutation is attributable, retained, and reversible through a
  new version.

### Milestone C: defensible experiment shipping

Complete EXP-DEC-1, EXP-DEC-2, and EXP-1 through EXP-4.

Exit criteria:

- Conversion rates cannot exceed one from duplicate goals.
- Progress reads cannot manufacture a fixed-horizon winner.
- Terminal decisions use trusted, deduplicated evidence and persist across
  restart.
- Shipping requires a terminal winner, healthy evidence, and the expected config
  version.

### Milestone D: high-demand single server

Complete PERF-1 through PERF-4 and REL-1.

Exit criteria:

- The complete feature set sustains the declared sync and latency targets on one
  reference server.
- Burst overload remains bounded and recovers without restart.
- SQLite writer queues, WAL, disk, RSS, and historical compaction remain bounded
  during the scheduled soak.
- Initialization, shutdown, restart, recovery, capacity, and proxy limits are
  documented and tested against released artifacts.

## Definition of done

This roadmap is complete when all of the following are true:

- Hourly and daily historical aggregate queries survive restart and obey exact
  retention and privacy contracts.
- Historical compaction is idempotent and cannot outrun source durability.
- Credential role scope is enforced from server-side metadata.
- Experiment decisions use trusted, deduplicated assignment units and a persisted
  fixed-horizon terminal analysis.
- Config mutations use optimistic concurrency and an atomic retained journal.
- Rollback creates a new auditable version.
- One local SQLite store preserves config, journal, aggregates, experiment
  evidence, and terminal decisions across restart.
- Full-feature sustained load, burst overload, SQLite recovery, compaction, and
  concurrent-control behavior have black-box and stress coverage.
- Merge and release gates fail automatically when their declared thresholds or
  correctness checks are missed.
- Documentation and agent skills describe only the single-server behavior proven
  by those gates and refer multi-replica operation to
  [CLUSTER_ROADMAP.md](CLUSTER_ROADMAP.md).
