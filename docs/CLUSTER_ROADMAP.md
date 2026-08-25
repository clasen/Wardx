# Wardx cluster roadmap

**Status:** deferred and optional

**Created:** 2026-08-24

**Goal:** add multi-process and multi-host availability only after the supported
single-server architecture is complete and a measured availability or capacity
requirement justifies the additional coordination

This roadmap is deliberately separate from
[PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md). Wardx does not need cluster mode to
complete its current product objective. The active roadmap proves that one
bounded `wardx-server` with local SQLite can sustain the declared high-demand
workload first.

## Entry criteria

Do not begin implementation until all of the following are true:

- the product roadmap is complete;
- full-feature single-node stress and soak gates pass on reference hardware;
- production measurements show either that one larger server cannot meet the
  required capacity or that host-level availability has an explicit objective;
- the maximum tolerated data loss, recovery time, and stale-read interval are
  written down;
- the SQLite replication/failover mechanism and any dependency are approved;
- operators are prepared to monitor replication, writer leadership, fencing,
  backups, and failover.

Traffic growth by itself is not proof that cluster mode is required. First test
larger hardware, batching, compaction cadence, SQLite checkpoint policy, and the
declared overload limits.

## Target topology

SQLite remains the authoritative store. Multi-host mode uses exactly one active
writer authority with SQLite-aware replication and fenced promotion.

```text
SDKs
  |
load balancer
  +--> Wardx A ----+
  +--> Wardx B ----+--> active writer --> SQLite primary
  +--> Wardx C ----+          |                  |
                              +---------- replication
                                                 |
                                          SQLite standby
```

Non-writer Wardx replicas may accept ingest only while they can submit their
bounded durable batches to the active writer. A promoted writer must fence the
previous generation before accepting mutations.

A `.sqlite` file shared through NFS or another general-purpose network filesystem
is not a cluster design and is not supported.

## Non-goals

This roadmap does not add:

- multiple simultaneous SQLite writers;
- consensus or replication implemented from scratch inside Wardx;
- eventual merging of independent Wardx databases;
- cross-region active-active operation;
- raw telemetry or per-subject analytics;
- transparent fallback to stale local JSON sidecars;
- a guarantee that best-effort telemetry accepted only in a failed replica's
  memory survives that failure.

## Phase 0: approve cluster contracts

### HA-DEC-1: availability objective

Define separately:

- process failure tolerance;
- host failure tolerance;
- storage failure tolerance;
- recovery time objective;
- recovery point objective;
- maximum read replication lag;
- maximum config propagation delay;
- behavior while no writer is available.

Recommended behavior while there is no fenced writer:

- readiness fails;
- new config and experiment mutations fail closed;
- read-only MCP may serve a snapshot only when its lag is within the declared
  bound and the response reports that watermark;
- ingest returns the documented bounded overload/unavailable response instead of
  building an unbounded local queue.

### HA-DEC-2: replication and promotion

Select an existing SQLite-aware replication and failover mechanism. Record:

- supported SQLite and Node driver versions;
- synchronous or asynchronous replication contract;
- leader discovery and promotion procedure;
- fencing mechanism and cluster generation;
- durability/checkpoint requirements;
- backup interaction;
- upgrade and rollback compatibility;
- operational ownership.

The selected mechanism is an external dependency and needs explicit approval.
Mocks or filesystem copies are not acceptable substitutes for its real failover
tests.

### HA-DEC-3: acknowledgement boundary

Define exactly when a Wardx replica may return success for:

- one telemetry sync;
- an aggregate batch submitted to the writer;
- a Remote Config mutation;
- an experiment terminal decision;
- an MCP read served from a replica.

Recommended contract:

- config, journal, experiment ledger, and terminal decisions acknowledge only
  after the active writer commits them under the current fenced generation;
- general telemetry remains best effort and may acknowledge after bounded local
  aggregation under the explicit loss contract;
- a batch acknowledged by the writer is idempotent and cannot be counted twice
  after replay;
- every replica response exposes no internal topology or credential details.

## Phase 1: cluster identity and writer authority

### HA-1: deployment mode

Add an explicit `cluster` deployment mode. Single-server mode remains the default
documented topology and keeps its independent verification gate.

Cluster configuration requires:

- non-secret cluster ID;
- unique replica ID;
- writer/replication endpoint settings;
- generation/fencing settings;
- maximum accepted replication lag;
- bounded local batch capacity and submission timeout;
- readiness and drain timeouts.

All operational values are required centralized settings with no fallback
defaults.

### HA-2: fenced writer transactions

The active writer owns:

- project-scoped config compare-and-swap;
- config mutation and journal entry in one transaction;
- experiment assignment-unit deduplication and terminal decisions;
- aggregate batch publication;
- historical compaction watermarks;
- schema migration serialization.

Every transaction validates the active cluster generation. Promotion changes the
generation before the new writer accepts work. A stale writer cannot commit after
fencing.

Verification:

- simultaneous mutations through different replicas produce one version winner;
- a stale generation cannot publish config, journal, experiment, or aggregate
  state;
- mutation failure changes neither authoritative state nor caches;
- restarting a former writer cannot regain authority without promotion.

## Phase 2: replica traffic and shared reads

### HA-3: bounded aggregate submission

Each ingest replica keeps its current bounded in-memory aggregation behavior and
submits coalesced deltas to the writer with unique batch IDs.

Requirements:

- retrying one writer batch is idempotent;
- local batch count, bytes, and age are bounded;
- writer unavailability triggers the declared fail-closed or best-effort drop
  behavior;
- a replica crash may lose only the explicitly documented unsubmitted interval;
- committed config, journal, experiment decisions, and writer-acknowledged batches
  cannot be lost by an ingest replica crash.

### HA-4: config propagation and MCP

Config changes become visible to every ready replica within the declared delay.

- Read-only MCP may use a local replicated snapshot only within the accepted lag.
- Mutating MCP routes to the active writer and requires `expectedVersion`.
- Historical query responses include their data watermark.
- Experiment shipping uses only the writer's persisted terminal decision.
- Catalog and credential caches invalidate by authoritative revision, not by a
  timer guess.

### HA-5: readiness and graceful drain

Cluster readiness fails when a replica:

- cannot load a compatible SQLite schema;
- cannot reach the writer within the declared bound;
- exceeds maximum replication or config lag;
- belongs to a stale cluster generation;
- cannot submit its bounded dirty state.

`/health` remains process liveness.

Shutdown order:

1. fail readiness;
2. drain proxy traffic;
3. finish in-flight sync handlers;
4. submit bounded dirty aggregate batches;
5. stop MCP mutations;
6. if this replica is writer, checkpoint and release or transfer fenced
   leadership according to the approved mechanism.

## Phase 3: migration and operations

### HA-6: promote a local database into a cluster

Provide a rerunnable operator command with dry-run and apply modes.

- Start from one stopped, validated product-roadmap SQLite database.
- Require an empty cluster target.
- Record source hash, schema version, row counts, cluster ID, and generation.
- Verify config, journal, aggregates, historical tiers, experiment ledger, and
  terminal decisions before traffic resumes.
- Re-running the completed import is idempotent.
- Rollback restores the pre-migration database and binary; post-migration cluster
  writes are not merged silently into the old local database.

### HA-7: backup, upgrade, and recovery

Document and test:

- replication-consistent backup and restore;
- writer loss during checkpoint and compaction;
- standby loss and rebuild;
- disk-full behavior on writer and standby;
- rolling binary/schema upgrade;
- rollback limits after a schema migration;
- credential rotation across replicas;
- planned writer switchover.

## Phase 4: failover and capacity proof

### HA-8: deterministic multi-replica tests

Run at least two Wardx processes against real SQLite databases and the selected
replication/failover mechanism.

Verify:

- config written through replica A is returned by replica B;
- simultaneous `expectedVersion` mutations have one winner;
- replayed aggregate batches are counted once;
- experiment evidence deduplicates across replicas;
- writer/compactor failure promotes one fenced successor without duplicate
  rollups;
- killing one ingest replica preserves availability through another;
- restart and rolling upgrade preserve historical and terminal experiment state;
- readiness removes disconnected, lagging, or incompatible replicas;
- a simulated partition cannot produce two writable leaders.

An in-memory SQLite database, mocked leader, or copied file is useful unit
coverage but is not HA proof.

### HA-9: cluster stress and failover gate

Report:

- total and per-replica sync throughput;
- p50/p95/p99 HTTP, writer-queue, and SQLite transaction latency;
- writer CPU, lock/busy counts, WAL size, checkpoint and fsync latency;
- local batch depth/age and aggregate flush lag;
- config propagation and read-replica lag;
- compaction lag;
- writer-promotion time and failover error budget;
- RSS, event-loop delay, and storage growth per process.

Publish no cluster throughput or recovery claim without the exact commit, replica
count, SQLite/driver versions, replication topology, durability settings, network
placement, hardware, workload, duration, failure injection, and full output.

## Milestones

### Milestone A: fenced writer

- One writer generation owns all authoritative mutations.
- Stale writers fail closed.
- Concurrent replica mutations preserve `expectedVersion` semantics.

### Milestone B: replicated reads and ingest

- Ready replicas observe config and history within the declared lag.
- Aggregate batch replay is idempotent.
- Writer unavailability cannot create an unbounded local queue.

### Milestone C: operational failover

- A real writer failure promotes one fenced successor.
- Backups, upgrades, rollback limits, and standby rebuild are documented and
  tested.
- Partition testing cannot produce split brain.

### Milestone D: release proof

- Multi-replica black-box, failover, and stress gates pass against packaged
  artifacts and the real replication mechanism.
- Single-server verification remains green and independently supported.

## Definition of done

Cluster mode is complete when:

- two or more Wardx replicas expose one config, journal, experiment, and aggregate
  truth;
- exactly one fenced writer can commit in a cluster generation;
- committed batches and experiment units are not duplicated across replay or
  failover;
- lagging, partitioned, and incompatible replicas fail readiness;
- migration, backup, drain, failover, upgrade, rollback limits, and capacity are
  documented and tested against released artifacts;
- the release gate fails automatically on split brain, duplicate data, missed
  failover objectives, or declared capacity regressions;
- no cluster claim weakens or obscures the separately proven single-server
  contract.
