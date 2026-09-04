# Wardx MCP tools

All tools except `list_projects` take the project name from that tool. Every
mutation also takes integer `expectedVersion >= 0` and non-empty `reason`.

## Read

| Tool | Main arguments |
| --- | --- |
| `list_projects` | none |
| `get_project_overview` | `project`, optional `limit`, exact `category` |
| `get_config` | `project` |
| `get_aggregates` | `project`; optional `names`, `from`, `to`, `role`, exact `category`; distinct rows return HLL estimate/precision |
| `get_aggregate_history` | `project`, `tier: hour|day`, bounded `from`, `to`; optional `role`, `environment`, `appVersion`, `names`, exact `category` |
| `get_recent_events` | `project`; optional exact `name`, `role`, listed scalar `attrs`, `limit`; newest timestamp first |
| `get_recent_logs` | `project`; optional `level`, exact `message`, exact `attrs`, `role`, `limit` |
| `list_experiments` | `project` |
| `analyze_experiment` | `project`, `experimentId` |
| `list_config_changes` | `project`; optional `after`, `limit` |

`get_aggregate_history` returns bucket rows plus finalization, drop count, and
newest compacted source watermark. `analyze_experiment.variants` contains
trusted decision rows; `telemetryVariants` includes all source/trust classes.
Distinct history rows return the merged estimate and precision without raw HLL
registers or identifiers.

`get_recent_events` reads only names enabled by that project's
`catalog.inspectEvents` from its `recentEventsMax` circular in-memory buffer.
Listed scalar attribute keys match exactly. Rows include all raw attrs and
`instanceId`, evict the oldest retained sample first, and disappear on process
restart. Events outside the allowlist remain aggregate counts only.

## Mutate

| Tool | Additional arguments |
| --- | --- |
| `set_project_description` | `description` |
| `set_role_description` | `role`, `description` |
| `set_role_source` | `role`, `path` and/or `git` |
| `set_signal` / `delete_signal` | `name`, plus `description` and optional exact `category` for set |
| `set_inspect_event` / `delete_inspect_event` | exact event `name`; delete also purges its retained volatile samples |
| `set_persist_log` / `delete_persist_log` | exact `name` |
| `set_config_value` | `key`, JSON `value`, `roles` |
| `delete_config_value` | `key` |
| `upsert_experiment` | `experiment` |
| `set_experiment_enabled` | `id`, `enabled` |
| `ship_experiment` | `experimentId`, optional matching `variant` |
| `rollback_config_change` | retained `changeId` |

`roles` is `['*']` or one or more named roles. A fixed-horizon experiment has
this server-side shape in addition to id/allocation/salt/roles/variants:

```json
{
  "goalMetric": "checkout.completed",
  "assignmentUnitKind": "session",
  "outcomeKind": "conversion",
  "control": "control",
  "targetSampleSizePerVariant": 500,
  "earliestAnalysisAt": 1787875200000,
  "familyWiseAlpha": 0.05,
  "minimumEffect": 0.02,
  "direction": "increase",
  "terminalRetentionMs": 604800000,
  "healthThresholds": {
    "maxDroppedFrames": 0,
    "maxDuplicateExposures": 10,
    "maxDuplicateGoals": 10,
    "maxConflictingGoals": 0,
    "maxVariantConflicts": 0,
    "maxUntrustedRows": 1000,
    "maxLateRows": 0,
    "maxMissingExposures": 0,
    "maxImplicitExposures": 0
  }
}
```

All fixed-horizon fields are all-or-none. `hypothesis` is optional and MCP-only.
Analysis policy, roles, retention, and shipped metadata stay off the client
wire. A descriptive experiment still requires `assignmentUnitKind` and
`terminalRetentionMs` but omits every fixed-horizon field.

Common errors include `version conflict: current version is N`, role/key
visibility failures, immutable-plan failures after trusted exposure, and
`persisted healthy terminal winner required` on premature shipping.
