# Wardx hardening roadmap

This roadmap turns the current audit findings into an implementation sequence. It is ordered by risk and dependency, not by implementation convenience. Security and data-correctness work comes before performance, tooling, and documentation polish.

The roadmap does not authorize public contract changes or new dependencies. Those decisions are called out explicitly and must be approved before implementation.

## Current baseline

As of 2026-08-24:

- The JavaScript suite passes 124 tests.
- The C# console suite passes all 8 test groups.
- The black-box test covers CLI startup, MCP over stdio, HTTP health, the public Node SDK, role-filtered Remote Config, telemetry, logs, and an MCP config update returning to the SDK.
- The smoke stress harness completes without HTTP errors.
- `npm pack --dry-run` succeeds for `@wardx/core`, `wardx`, and `@wardx/server`.

These checks prove the main happy path. They do not prove hostile-input safety, production persistence throughput, role authorization, multi-experiment correctness, real C# HTTP interoperability, or a published-package installation.

## Release priorities

| Priority | Meaning | Release policy |
| --- | --- | --- |
| P0 | Remotely triggerable process or data-integrity risk | Do not expose the ingest server to untrusted networks until complete. |
| P1 | Incorrect analytics, lost telemetry, misleading experiment decisions, or production bottleneck | Complete before calling the current architecture production-ready. |
| P2 | Operational, packaging, documentation, or long-running-process maturity | Complete before a stable release. |

## Phase 0: decide the public contracts

These decisions affect external users or persisted formats. Record each result in the existing protocol or architecture documentation before changing code.

### [DEC-1] Define whether roles are routing or authorization

Current behavior: a project key authenticates the project, while the client chooses any non-empty role. Role filtering therefore reduces payloads but does not protect backend-only configuration or telemetry integrity.

Recommended decision: treat the current role as routing metadata only in the short term and state that clearly. For actual isolation, design project credentials with allowed roles, for example a key mapping to `{ project, roles }`. Continue to prohibit secrets in Remote Config even after role authorization exists.

Acceptance criteria:

- The security guarantee is explicit in `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, and the server README.
- If role authorization is selected, the config migration and key-rotation path are defined before implementation.
- Tests cover both the intended role and a forbidden role using the same credential.

### [DEC-2] Associate experiment goals with exactly one experiment

Current behavior: `experiment.goal(name)` attaches every known assignment for the subject. Concurrent experiments can therefore count the same goal even when their intended metrics differ.

Recommended decision: add an explicit `goalMetric` to experiment definitions and attach a goal only when its name matches. This preserves the existing SDK call shape while making the experiment contract unambiguous. An explicit `experimentId` argument is an alternative, but it is a larger SDK API change.

Acceptance criteria:

- One goal can affect only its intended experiment.
- Node and C# implement identical matching semantics.
- Existing stored experiment definitions have a documented migration rule; no compatibility fallback is added implicitly.
- The server refuses to ship an experiment whose close policy lacks an unambiguous goal.

### [DEC-3] Define retention and historical-analysis claims

Current production configuration retains aggregate windows for 60 minutes, keeps a bounded non-persistent recent-log ring, and persists only selected lifetime rollups. Wardx does not store per-subject journeys or act as a ledger.

Recommended decision: keep Wardx aggregate-first and narrow the product claims. If multi-day analysis is required, design it as a separate durable retention feature with storage, query, capacity, and backup requirements rather than stretching the current sidecars.

Acceptance criteria:

- The supported history window is stated exactly.
- Per-subject claims are removed unless a separately designed store supports them.
- Any statement that an agent returns days later identifies the external scheduler or automation responsible.

### [DEC-4] Define oversized-frame behavior

Current behavior: logs, events, histograms, and gauges can be removed, but a counter-heavy frame may still exceed `maxFrameBytes`.

Recommended decision: split a fitted snapshot into bounded frames while preserving counter deltas and sequence order. If splitting cannot preserve the at-most-once contract, define and count counter drops explicitly instead of silently exceeding the limit.

Acceptance criteria:

- Every emitted frame is at most `maxFrameBytes` when measured with the documented encoding.
- Dropped data is observable through `wardx.internal.*` metrics.
- Node and C# use the same policy and fixtures.

## Phase 1: protect the ingest boundary

Complete this phase before exposing `/v1/sync` outside a trusted network.

### [ING-1, P0] Bound decompression

Apply `maxRequestBytes` to both the compressed request body and the decoded JSON envelope, unless Phase 0 explicitly defines a different centralized setting. Do not add a fallback value.

Implementation outline:

1. Reject unsupported `Content-Encoding` values.
2. Decompress with a hard output limit or a bounded stream.
3. Return `413` when either compressed or decoded data exceeds the limit.
4. Keep malformed gzip distinct from oversized gzip.

Verification:

- A small gzip that expands beyond the limit receives `413` without an unbounded allocation.
- Corrupt gzip receives `400`.
- Plain and gzip envelopes at the exact limit behave consistently.
- The black-box test runs the cases through the CLI process, not a handler mock.

### [ING-2, P0] Validate the complete wire envelope

Validate before the sink, aggregator, recent-client ring, recent-log ring, or persistence layer sees the data.

Required validation:

- Reject unknown or malformed top-level, SDK, client, frame, and metric structures according to the protocol policy.
- Require finite `seq`, `from`, `to`, metric values, timestamps, histogram totals, bounds, and exemplars.
- Validate tuple lengths and every counter, gauge, histogram, event, and log field.
- Enforce non-empty names, supported log levels, dimension/attribute shapes, and existing size/cardinality limits.
- Require coherent histogram bodies: non-negative counts, ordered bounds, finite sums, `min <= max`, and bucket totals that do not exceed `count`.
- Define and enforce acceptable clock skew so future timestamps cannot escape retention indefinitely. Any new operational limit belongs in centralized configuration with no fallback.
- Bound frames and total collection items per envelope so a structurally valid request cannot create excessive CPU work.

Verification:

- Table-driven unit tests cover every rejected field and boundary.
- Black-box cases cover non-finite timestamps, future timestamps, string counter values, malformed tuples, invalid histogram bodies, and excessive collection sizes.
- Invalid input returns `400`, changes no sink or aggregate state, and creates no sidecar.
- A rejected request cannot make the next restart fail hydration.

### [ING-3, P1] Document and enforce network-layer controls

Keep TLS termination and coarse rate limiting at a reverse proxy unless the deployment contract requires them in the Node process.

Acceptance criteria:

- Production documentation includes TLS, request-rate limits, body limits, timeouts, and trusted proxy behavior.
- Key rotation supports an overlap period without downtime.
- Configuration-file permissions and log redaction rules are documented.
- Remote Config explicitly forbids secrets.

## Phase 2: restore telemetry and experiment correctness

### [SDK-1, P1] Implement the selected experiment-goal contract

Implement DEC-2 in `@wardx/core`, the Node types, C#, protocol fixtures, server aggregation, analysis, and documentation.

Verification:

- Two simultaneous experiments with different goals do not contaminate each other.
- Conversion and quantitative-mean goals still produce correct lifetime totals.
- A subject allocated to multiple experiments generates only the intended goal row.
- Cross-language fixtures produce the same wire payload.

### [SDK-2, P1] Make C# shutdown flush before cancellation

Separate scheduler cancellation from the token used by the final transport flush. Stop new scheduled work, settle the current sync according to the documented policy, flush with an independent bounded token, and close the transport only afterward.

Verification:

- A real HTTP server receives pending C# frames during `ShutdownAsync`.
- Shutdown remains idempotent.
- A bounded transport timeout cannot leave shutdown hanging indefinitely.
- Cancellation and HTTP failure increment the documented internal failure metric.

### [SDK-3, P1] Enforce the frame-size contract

Implement DEC-4 in both SDKs. Measure the final serialized representation and assert the bound before transport.

Verification:

- Counter-only, mixed, and internal-metric-heavy frames remain within the limit.
- Split or drop accounting is deterministic.
- Frame sequence numbers remain monotonic.
- Node and C# pass shared maximum-size fixtures.

### [SDK-4, P2] Bound experiment assignment state

The current resolver retains raw subject IDs and exposure keys for the life of a process. Design bounded session state suitable for a backend serving many subjects.

Implementation requirements:

- Do not rely on the current 32-bit subject hash as the only internal deduplication identity.
- Clear obsolete assignments when a config snapshot removes, disables, or changes an experiment.
- Define a bounded capacity or lifetime in centralized settings; do not add a silent default.
- Preserve deterministic assignment without retaining every raw subject indefinitely.

Verification:

- A long-running million-subject test demonstrates bounded memory.
- Hash collisions do not suppress unrelated exposures.
- Snapshot changes remove obsolete assignment state.
- Per-session exposure semantics stay consistent across Node and C#.

## Phase 3: make persistence safe and representative

### [PER-1, P1] Coalesce aggregate and lifetime-stat writes

Current ingest persists the full retained aggregate snapshot synchronously after each changed request when `configPath` exists. Replace this with one bounded, coalescing persistence path.

Implementation requirements:

- Mark state dirty during ingest and keep request handling free of synchronous filesystem work.
- Allow at most one write in flight and coalesce subsequent changes.
- Flush dirty state during graceful shutdown.
- Surface write failures without losing the dirty state.
- Put any flush interval or queue bound in centralized server configuration with no fallback.
- Preserve atomic replacement and validate snapshots before publishing them.

Verification:

- Burst traffic performs a bounded number of writes.
- A write occurring while new data arrives schedules another flush.
- Graceful shutdown persists the final window, log stats, and experiment stats.
- A failed write remains observable and can be retried according to the selected policy.

### [PER-2, P1] Make control-plane mutation publication transactional

Do not expose a new in-memory config version to clients before its durable write succeeds when persistence is configured.

Verification:

- Simulated disk failure leaves both memory and disk on the previous version.
- A successful mutation publishes exactly one new version.
- Catalog-only mutations retain their no-version-bump contract.
- Restart returns the same state MCP reported before shutdown.

### [PER-3, P1] Benchmark the production persistence path

The current server benchmark constructs an in-memory config without `configPath`, so it excludes sidecar writes.

Required benchmark profiles:

- Raw `NullSink` ingest with persistence disabled, labeled as an upper bound.
- CLI-equivalent config with `configPath` and retained windows enabled.
- Growing retention state, not only an empty or single-window snapshot.
- Disk latency, write count, event-loop delay, CPU, RSS, p50, p95, p99, and errors.

Acceptance criteria:

- The documented 5,000 sync/s target identifies the exact profile and hardware assumptions.
- Smoke mode fails when its own declared smoke thresholds are exceeded.
- Full mode exits non-zero when a release gate fails.

### [PER-4, P2] Define sidecar recovery and backup

Keep crash-early validation for corrupt persisted data, but provide an operator workflow.

Acceptance criteria:

- Documentation identifies every sidecar, its retention, and whether it is authoritative or rebuildable.
- Backup and restore order is documented for the server config and sidecars.
- Disk-full, permission, corrupt-file, and interrupted-rename behavior is tested.
- Recovery never silently discards corrupt data.

## Phase 4: complete black-box and cross-language coverage

Extend `packages/server/test/black-box.test.js` or split it only when isolation or runtime justifies separate files.

### [E2E-1] HTTP failure matrix

Cover health, missing and unknown keys, project mismatch, gzip corruption, invalid JSON, unsupported encoding, invalid protocol, invalid role including `*`, oversized compressed and decoded payloads, and removed admin routes.

### [E2E-2] At-most-once delivery

Make the first sync fail, bring up a receiving server, and verify the discarded batch is not retried while failure telemetry remains observable.

### [E2E-3] Experiment lifecycle

Through public SDK, HTTP, and MCP surfaces only:

- Distribute role-filtered experiment config.
- Verify deterministic assignment and one exposure per subject/session.
- Verify raw subject IDs never appear on the wire.
- Record the intended goal, analyze it, reach a valid decision, and ship only the declared winner.

### [E2E-4] CLI persistence and restart

Mutate config and catalog through MCP, ingest aggregates and allowlisted logs, stop gracefully, restart the CLI, and verify config and sidecars hydrate. Also verify that the recent-log ring is intentionally lost.

### [E2E-5] Real C# interoperability

Run the C# SDK against a real `wardx-server` process. Verify gzip, headers, SDK/platform identity, frames, role-filtered Remote Config, experiment assignment, flush, and shutdown. The in-memory C# transport remains useful as a unit test but is not interoperability proof.

### [E2E-6] Installed-artifact test

Run `npm pack`, install the generated tarballs in a temporary clean project, import all public packages, and launch the packaged `wardx-server` binary. Do not resolve source files from the monorepo in this test.

### [E2E-7] Lifecycle and handle cleanup

Verify bootstrap without connectivity, explicit flush, idempotent shutdown, timeout behavior, and process exit without leaked timers, sockets, or child processes.

## Phase 5: observability and operational behavior

### [OPS-1, P1] Preserve internal error evidence

The HTTP layer currently returns `500 internal` while discarding the exception. Add a structured server diagnostic sink or callback that defaults only when the centralized configuration explicitly provides it. Never log keys, request bodies, subject IDs, or secrets.

Acceptance criteria:

- Disk, persistence, validation, and unexpected handler failures have actionable local diagnostics.
- HTTP clients continue to receive non-sensitive errors.
- Logging failure cannot recursively fail the request path.

### [OPS-2, P2] Add readiness and shutdown documentation

Define what `/health` proves. If operators need persistence/config readiness beyond process liveness, add a separate readiness contract rather than changing `/health` silently.

Document:

- Startup failure on corrupt config or sidecars.
- Signal handling and graceful-flush expectations.
- Reverse-proxy timeouts and maximum body settings.
- Expected memory and disk growth.
- Upgrade, rollback, and key-rotation procedures.

## Phase 6: establish one reliable verification gate

### [QA-1, P1] Add explicit repository scripts

Recommended scripts, implemented without changing dependencies unless separately approved:

- `test:js`: current Node test suite.
- `test:black-box`: public CLI/SDK/MCP tests.
- `test:csharp`: current C# suite plus real HTTP interoperability when available.
- `stress:smoke`: bounded developer/CI smoke checks.
- `pack:check`: pack and install public tarballs in a clean temporary project.
- `verify`: the complete merge gate excluding long stress.
- `verify:release`: merge gate plus full stress and package checks.

Do not call a command a gate unless it exits non-zero when its criteria fail.

### [QA-2, P2] Add CI

Minimum matrix:

- Lowest supported Node 20 and the current maintained Node version.
- .NET 9 for the C# runtime.
- JavaScript unit/integration tests.
- Black-box CLI test with local sockets.
- C# unit and HTTP interoperability tests.
- Package tarball installation.
- Stress smoke as a separate, measurable job.

Keep full five-minute stress and million-subject checks in the release workflow or a scheduled workflow so normal changes remain fast.

### [QA-3, P2] Add lint and type-contract checks

Selecting a linter or TypeScript checker adds development dependencies and therefore requires approval first.

Once approved, verify:

- JavaScript formatting and static errors.
- Public `.d.ts` declarations against representative consumer code.
- Package exports in both supported import modes.
- C# formatting/analyzers without changing runtime semantics.

## Phase 7: align documentation with the proven product

Update documentation only after the relevant behavior or decision is settled.

Required corrections:

- Replace multi-day and per-account claims that the current aggregate retention cannot support.
- State that delayed follow-up requires an external agent scheduler or automation.
- Replace “the server always replies ok” with the documented success and error matrix.
- Describe Node instance/session IDs as belonging to one SDK instance unless a process-wide singleton is intentionally introduced.
- State whether role filtering is routing or authorization.
- Qualify Node/C#/Unity parity until real HTTP cross-language tests exist.
- Identify which stress profile supports every published performance number.
- Add production guidance for TLS, reverse proxy, rate limiting, key rotation, backups, recovery, and sidecar capacity.

Verification:

- Every capability claim points to a passing automated test or an explicitly external dependency.
- README examples match the current public API and configuration schema.
- Protocol examples pass validation as test fixtures.
- Skills and package READMEs are updated in the same change as their source-of-truth documentation.

## Definition of done

The hardening roadmap is complete when all of the following are true:

- Hostile compressed or malformed input is bounded and rejected before state mutation.
- Concurrent experiments cannot contaminate each other's goals.
- Every emitted Node and C# frame respects the declared byte limit.
- C# shutdown demonstrably delivers its final pending batch to a real server.
- Experiment assignment state remains bounded in long-running multi-user processes.
- Ingest performs no synchronous filesystem work per request.
- Durable control mutations cannot diverge between memory and disk.
- Production-equivalent persistence is included in performance evidence.
- Roles have a documented trust model, with authorization implemented if isolation is promised.
- The public packages pass clean-install black-box tests from tarballs.
- One documented verification command covers JS, C#, black-box, packaging, and smoke gates.
- Full release stress fails automatically on a missed target.
- Product, protocol, package, and operational documentation describe only verified behavior.

## Recommended execution order

1. Approve DEC-1 through DEC-4.
2. Implement ING-1 and ING-2 with hostile-input black-box regression tests.
3. Implement SDK-1 through SDK-3 with shared Node/C# fixtures.
4. Implement PER-1 through PER-3 and rerun production-equivalent stress.
5. Complete the remaining E2E coverage, especially real C# HTTP and installed tarballs.
6. Add operational diagnostics and recovery documentation.
7. Consolidate scripts and CI gates.
8. Align all public documentation and run the complete release verification.
