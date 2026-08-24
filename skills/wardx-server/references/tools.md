# Wardx MCP tools

All tools except `list_projects` require `project`: the project **name** from `list_projects`, not the ingest key.

Resource `wardx://project/{name}` returns the same JSON as `get_project_overview`.

## Catalog (no `configVersion` bump)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_projects` | _(none)_ | `{ projects: string[] }` |
| `get_project_overview` | `project`, optional `limit` (max counters, events, histograms, and persist logs per role, highest first) | description, `onboarding`, `knobs`, `persistLogs`, `roles` (outcomes + clients, optional `path`/`git`), `experiments`, `version`. Histogram outcomes are ranked by `max` and include `exemplar` when the peak had attrs. Persist log outcomes are `kind: "log"` with lifetime `count` and last `exemplar`. |
| `set_project_description` | `project`, `description` | `{ project }` |
| `set_role_description` | `project`, `role`, `description` | `{ project, role }` |
| `set_role_source` | `project`, `role`, and `path` and/or `git` | `{ project, role }` |
| `set_signal` | `project`, `name`, `description` | `{ project, name }` |
| `delete_signal` | `project`, `name` | `{ project, name }` |
| `set_persist_log` | `project`, `name` (exact log message) | `{ project, name }` |
| `delete_persist_log` | `project`, `name` | `{ project, name }` |

`role` is an open client role name. It cannot be `*`.

## Remote Config and experiments (bumps `configVersion`)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_config` | `project` | `{ version, values, experiments }` |
| `set_config_value` | `project`, `key`, `value`, `roles` | `{ version }` |
| `delete_config_value` | `project`, `key` | `{ version }` |
| `list_experiments` | `project` | `{ experiments }` including `hypothesis` when set |
| `upsert_experiment` | `project`, `experiment` | `{ version }` |
| `set_experiment_enabled` | `project`, `id`, `enabled` | `{ version }` |
| `ship_experiment` | `project`, `experimentId`, optional `variant` | `{ version, shippedVariant }` |

`roles` is `["*"]` or a list of role names. Do not mix `*` with named roles.

`experiment` object:

```json
{
  "id": "message-delay-v1",
  "enabled": true,
  "allocation": 1,
  "salt": "3ad8f9",
  "primaryMetric": "message.sent",
  "goalMetric": "message.sent",
  "roles": ["client"],
  "hypothesis": "Shorter delay increases messages sent",
  "goalKind": "conversion",
  "control": "control",
  "minExposures": 50,
  "confidence": 0.95,
  "variants": [
    { "key": "control", "weight": 50, "values": { "message.delayMs": 1000 } },
    { "key": "fast", "weight": 50, "values": { "message.delayMs": 400 } }
  ]
}
```

Required: `id`, `enabled`, `allocation` ∈ [0, 1], `salt`, `goalMetric`, `roles`, `variants` (non-empty; weights sum to > 0). Optional: `primaryMetric`, `hypothesis`, `goalKind` (`conversion` | `mean`), `control`, `minExposures`, `confidence`. `hypothesis` and the close-policy fields are stripped before the snapshot goes to clients. A closable test needs all four policy fields; there is no implicit `minExposures` or `confidence`. Only a goal whose name equals `goalMetric` attaches to the experiment; there is no compatibility fallback. `ship_experiment` refuses unless `analyze_experiment.decision.status` is `winner` (or already shipped that variant).

Keep `salt` when replacing the same `id`. Assignment is client-side and deterministic (`experimentId + subjectId + salt`). The server does not map users. Clients `identify()` or pass `subjectId` on `config.get` / `experiment.goal`; no subject and that read is Remote Config with no exposure.

## Telemetry (read-only)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_aggregates` | `project`, optional `names[]`, `from`, `to`, `role` | `{ windows }` with catalog legends on names. Histogram bodies include `max` and optional `exemplar`. Allowlisted logs appear as `logNames` (`count` + last `exemplar`). |
| `get_recent_logs` | `project`, optional `level` (`debug`\|`info`\|`warn`\|`error`), `message` (exact), `attrs` (exact match on listed keys), `role`, `limit` | `{ logs }` newest first |
| `analyze_experiment` | `project`, `experimentId` | definition + hypothesis, lifetime `variants[]` with `exposures`/`goals`/`goalSum`/`goalSumSq`/`goalMean`/`rate`, `decision`, optional `primaryMetric` fleet total |

Undescribed names include `{ undescribed: true }` instead of `{ description }`.

## Common errors

| Message | Cause |
| --- | --- |
| `unknown project: …` | Name not in `list_projects` |
| `unknown config key: …` | Delete or experiment on a key that is not in `values` |
| `config key … is not visible to role …` | Experiment roles cannot see that key |
| `config key … is not visible to all roles` | Experiment `roles: ["*"]` but the key is not `["*"]` |
| `unknown experiment: …` | `set_experiment_enabled` / analyze / ship on a missing id |
| `experiment … is not ready to ship` | `ship_experiment` while `decision.status` is not `winner` |
| `unknown signal: …` | `delete_signal` on a name not in the catalog |
| `unknown persist log: …` | `delete_persist_log` on a name not in `persistLogs` |
| `path or git is required` | `set_role_source` with neither field |
| `role cannot be *` | `*` is only valid inside a `roles` array as the sole entry |
