# @wardx/server internals

## Main boundaries

| Path | Responsibility |
| --- | --- |
| `src/server.js` | Construct one server, SQLite store, capacity gates, control and graceful shutdown. |
| `src/loadConfig.js` | Closed required operational config; no defaults. |
| `src/auth/CredentialRegistry.js` | Authenticate raw keys and authorize claimed roles. |
| `src/ingest/` | Bounded HTTP read/validation and pre-mutation capacity checks. |
| `src/storage/SqliteStateStore.js` | Schema v1, WAL, project state, journal, aggregate tiers, watermarks. |
| `src/storage/ExperimentLedger.js` | Durable SHA-256 assignment dedupe, provenance, totals, terminal output/expiry. |
| `src/aggregation/history/` | Canonical historical rows and deterministic compaction. |
| `src/control/ControlService.js` | MCP reads/mutations, experiment gates, journal publish. |
| `src/control/MutationJournal.js` | CAS, audit-safe reversible entry, rollback-as-new-version. |
| `src/control/PersistenceCoordinator.js` | Coalesced minute writes, restart scans, compaction, retention, metrics. |
| `src/mcp/` | Public schemas, bounded reads, stdio resources/tools. |

## Contracts

- No admin HTTP route and no multi-process/shared-SQLite mode.
- Operational JSON owns settings/credentials and bootstraps an empty DB. SQLite
  owns project state thereafter. Do not add sidecar or compatibility fallback.
- Every config/catalog/experiment mutation uses `expectedVersion` and `reason`.
  Commit project state and one journal entry atomically before `_publish`.
- Credential trust comes only from `CredentialRegistry`; never from wire data.
- General history is preflighted then coalesced. Experiment evidence is
  transactionally accepted before HTTP success.
- Historical rows exclude attrs, exemplars, instance IDs, and subject hashes.
- Source retention requires durable downstream bucket plus watermark.
- Fixed-horizon plans are all-or-none and immutable after trusted exposure.
  Terminal analysis is first-write-wins.
- Current aggregates/rings are memory-only. Hour/day history and experiment
  evidence survive restart.
- All bounds live in config: sync handlers, pending SQLite batches/bytes,
  write batch, transaction/busy/checkpoint policy, history ranges/rows/
  retention/cardinality, journal, MCP reads, and ledger rows.

## Required config groups

Top-level required groups include `credentials`, `sqlite`, `history`, `control`,
`capacity`, `experiments`, and `projects`, in addition to HTTP/envelope/sink/
current-window settings. See `REQUIRED*` in `src/loadConfig.js`; never duplicate
that list here in code or add a fallback.

Each credential contains `label`, `project`, `allowedRoles`,
`trustedForDecisions`, and `enabled`. Each project contains `version`, `values`,
`keyRoles`, `experiments`, and optional `catalog`. Every experiment has
`goalMetric`, `assignmentUnitKind`, `terminalRetentionMs`, roles, and variants.

## Verification

```bash
npm run lint
npm run typecheck
npm run test:js
npm run test:csharp
npm run check:csharp
npm run stress:smoke
npm run pack:check
```

Use focused server tests first. Socket tests need loopback capability. The
release gate adds the five-minute full-feature workload; its result is hardware
evidence, not a deterministic unit-test claim.
