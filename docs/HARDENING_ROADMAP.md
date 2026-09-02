# Wardx MVP hardening

**Status:** implemented in the current worktree

**Status reviewed:** 2026-08-24

**Scope:** security, correctness, persistence, packaging, and verification of the
single-process aggregate-first MVP

This document records the outcome of the original hardening roadmap. It is no
longer an implementation backlog. A completed item means that implementation and
automated coverage exist in the repository; it does not replace running the
verification gates on the exact commit being released.

The next product and architecture work lives in
[PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md). That roadmap covers durable historical
rollups, statistically safe experiment decisions, minimal control-plane and
ingest trust controls, local SQLite durability, and high-demand single-server
capacity. Optional multi-replica work lives in
[CLUSTER_ROADMAP.md](CLUSTER_ROADMAP.md).

## Settled contracts

The four decisions that originally blocked hardening are now explicit public
contracts.

### DEC-1: roles are routing metadata

The project key authenticates a project. The client chooses its `role`, so role
filtering separates payloads and Remote Config views but is not authorization or
a telemetry-integrity guarantee. Remote Config must not contain secrets.

Role-scoped credentials and trusted experiment sources are intentionally outside
the MVP contract. They are planned in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md).

### DEC-2: one goal metric selects one experiment

Every experiment requires one non-empty `goalMetric`. A goal is emitted only for
a previously exposed assignment whose `goalMetric` matches the call. Enabled
experiments with overlapping roles cannot share the same goal metric.

There is no legacy match-all behavior.

### DEC-3: Wardx is aggregate-first

The server retains configured 1-minute aggregate windows, a bounded volatile log
ring, selected lifetime log rollups, and lifetime experiment totals. It does not
store journeys, per-account history, unique-user funnels, a ledger, or general
multi-day analytics. Delayed review requires an external scheduler or automation.

Longer-lived hourly and daily aggregate rollups are planned separately. They do
not change this no-journey contract.

### DEC-4: every physical frame is bounded

Node and C# measure serialized UTF-8 JSON and split logical snapshots into
consecutive physical frames no larger than `maxFrameBytes`. An indivisible row is
dropped and reported through `wardx.internal.frame_rows_dropped`; an oversized
frame is never sent silently.

## Completed implementation

### Ingest boundary

- [x] Compressed input and decoded gzip output are independently bounded by
  `maxRequestBytes`.
- [x] Unsupported encodings, corrupt gzip, invalid JSON, protocol mismatches,
  malformed tuples, non-finite values, incoherent histograms, clock skew, and
  excessive collections are rejected before state mutation.
- [x] Wire envelopes use a closed schema with centralized limits for names,
  dimensions, attributes, frames, and collection items.
- [x] Expected client failures receive non-sensitive HTTP responses; unexpected
  failures are sent to the configured local diagnostic sink.
- [x] TLS, proxy limits, request-rate limits, trusted forwarding headers, key
  rotation, and secret-redaction requirements are documented as deployment
  responsibilities.

Primary evidence:

- `packages/server/src/ingest/readBody.js`
- `packages/server/src/ingest/syncHandler.js`
- `packages/server/src/ingest/validate.js`
- `packages/server/test/validate.test.js`
- `packages/server/test/sync.test.js`
- `packages/server/test/black-box.test.js`

### SDK and protocol correctness

- [x] Node and C# associate goals with one matching exposed experiment.
- [x] Node and C# split counter-only, mixed, and internal-metric-heavy frames to
  the declared byte limit using shared fixtures.
- [x] C# shutdown stops scheduling, settles current work, performs a bounded
  final flush with an independent token, and closes the transport afterward.
- [x] Real C# to `wardx-server` HTTP interoperability covers gzip, headers,
  identity, role-filtered config, experiments, flush, and shutdown.
- [x] Experiment assignment state is bounded, stores hashed subject identities,
  distinguishes known 32-bit assignment-hash collisions, and removes stale
  assignments when experiment snapshots change.

Primary evidence:

- `packages/core/src/config/ExperimentResolver.js`
- `packages/core/src/frame/FrameBuilder.js`
- `packages/core/test/experiments.test.js`
- `packages/core/test/frame.test.js`
- `clients/csharp/Runtime/Client/WardxClient.cs`
- `clients/csharp/Runtime/Core/Frame/FrameBuilder.cs`
- `clients/csharp/Tests/ExperimentTests.cs`
- `clients/csharp/Tests/FrameTests.cs`
- `clients/csharp/Tests/SyncTests.cs`
- `packages/server/test/csharp-interop.mjs`

### Persistence and recovery

- [x] Aggregate windows, experiment totals, and allowlisted log totals use one
  asynchronous coalescing coordinator instead of synchronous writes per ingest.
- [x] At most one sidecar write is in flight; changes arriving during a write
  trigger another drain.
- [x] Failed writes preserve dirty state, report diagnostics, and remain
  retryable.
- [x] Graceful shutdown flushes final aggregate, experiment, and log state.
- [x] Control-plane mutations persist before publishing the new in-memory config
  version, preventing memory/disk divergence on write failure.
- [x] Sidecar hydration validates complete closed schemas and fails startup on
  corrupt or truncated persisted data.
- [x] Atomic replacement, permission failure, interrupted rename, backup,
  restore, disk-full response, upgrade, and rollback expectations are covered by
  tests or production documentation.

Primary evidence:

- `packages/server/src/control/PersistenceCoordinator.js`
- `packages/server/src/control/persist.js`
- `packages/server/src/control/ControlService.js`
- `packages/server/test/persistence-coordinator.test.js`
- `packages/server/test/aggregate-windows.test.js`
- `packages/server/test/experiment-stats.test.js`
- `packages/server/test/log-stats.test.js`
- `packages/server/test/control.test.js`
- `packages/server/README.md`

### End-to-end behavior

- [x] The CLI black box covers startup, liveness, MCP stdio and authenticated
  Streamable HTTP, public Node SDK sync, hostile HTTP inputs, role-filtered
  config, telemetry, logs, experiment proposal/analysis/shipping, persistence,
  restart, and intentional volatile-ring loss.
- [x] Failed Node frames remain at-most-once and failure telemetry appears on a
  later successful frame.
- [x] Public tarballs install in a clean temporary project, resolve from the
  installed artifacts, expose their public imports, and launch the packaged
  `wardx-server` binary.
- [x] Lifecycle coverage includes bootstrap without connectivity, explicit
  flush, concurrent/idempotent shutdown, bounded timeout behavior, and packaged
  process exit.

Primary evidence:

- `packages/server/test/black-box.test.js`
- `packages/node/test/sdk.test.js`
- `packages/stress/src/pack-check.js`

### Performance and release gates

- [x] The server benchmark separates a raw `NullSink` upper bound from a
  CLI-equivalent persistence profile with `configPath`, retained windows,
  growing series, and coalesced sidecar writes.
- [x] Reports include throughput, errors, p50/p95/p99 latency, event-loop delay,
  CPU, RSS, disk bytes, write count, and write latency.
- [x] Smoke and full profiles exit non-zero when their declared limits are
  missed.
- [x] Full release verification includes both five-minute server profiles and
  the million-subject assignment check.
- [x] CI covers Node 20 and current Node, JavaScript, type declarations, CLI
  black box, C#/.NET 9 interoperability and formatting, stress smoke, and clean
  package installation.

Primary evidence:

- `packages/stress/src/server-benchmark.js`
- `packages/stress/src/experiment-consistency.js`
- `docs/STRESS.md`
- `package.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release-verification.yml`

### Operations and documentation

- [x] `/health` is explicitly liveness, not readiness.
- [x] Startup, graceful drain, persistence flush, proxy behavior, key rotation,
  file permissions, diagnostics, capacity planning, backup/restore, upgrade, and
  rollback are documented.
- [x] Product claims distinguish current retained windows, bounded logs, selected
  lifetime rollups, and external scheduling from journeys or general analytics.
- [x] Node/C#/Unity parity is limited to behavior covered by shared fixtures or
  real interoperability tests.
- [x] Stress targets are labeled as targets, not benchmark results, and require
  the exact profile, runtime, hardware, and output when published.

Primary evidence:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/PROTOCOL.md`
- `docs/STRESS.md`
- `packages/server/README.md`
- `packages/node/README.md`
- `clients/csharp/README.md`

## Verification gates

The merge gate is:

```bash
npm run verify
```

It runs lint, public type-consumer checks, the JavaScript suite, CLI black box,
C# suite and real interoperability, C# formatting/analyzers, both persistence
smoke profiles, and clean tarball installation.

The release gate is:

```bash
npm run verify:release
```

It adds both five-minute server profiles and the million-subject experiment
assignment check. A release is not verified until these commands pass on the
exact release commit and the results are retained.

## Residual product limits

The items below are not incomplete MVP-hardening work. They are deliberate
current boundaries whose removal requires new contracts and architecture:

1. General aggregate history ends at `aggregateRetentionMinutes`; there are no
   hourly/daily baselines.
2. Experiment decisions use repeated fixed-confidence normal intervals after a
   caller-selected minimum sample. Conversion goals are counted as received and
   are not deduplicated by assignment unit on the server.
3. Project credentials do not restrict roles or establish trusted telemetry.
   MCP mutations have no optimistic version precondition, durable change record,
   or application-level rollback operation.
4. Runtime aggregation, MCP control, and persistence are designed around one
   process and local files; replicas do not share one authoritative state.

The first three limits and single-server capacity are the scope of
[PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md). The fourth is intentionally deferred to
[CLUSTER_ROADMAP.md](CLUSTER_ROADMAP.md); it is not required to complete the
active product roadmap.

## Definition of closed

This hardening roadmap remains closed when:

- `npm run verify` passes for every merge;
- `npm run verify:release` passes for every release candidate;
- changes to the wire, persisted formats, configuration, or public tools add
  matching unit, black-box, clean-package, and cross-runtime coverage;
- production claims continue to distinguish deterministic repository proof from
  external proxy, filesystem, network, hardware, and deployment behavior.
