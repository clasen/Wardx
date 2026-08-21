---
name: wardx-server
description: Operates the Wardx ingest control plane over MCP — catalog onboarding, Remote Config, experiments, 1-minute aggregates, and recent logs. Use when the user mentions Wardx, wardx-server, @wardx/server, Remote Config, experiments, ingest, telemetry, get_project_overview, set_config_value, upsert_experiment, analyze_experiment, POST /v1/sync, or MCP tools on the Wardx process. Also use when changing packages/server (ControlService, ingest, MCP tools, config schema). Do not use for writing SDK instrumentation (metrics, events, config.get) — that belongs to wardx-node.
---

# Wardx server

One process, two doors. There is no admin HTTP API.

- **Clients** speak `POST /v1/sync` (frames up, that role's Remote Config down).
- **Agents** speak MCP on the same process (tools + `wardx://project/{name}`).

A project is one product. Each SDK instance declares a `role` (`unity`, `game-server`, `desktop`, `mobile`, …). Roles share the project; series stay separate by role. A sync downloads only keys and experiments visible to that instance's role.

Meaning lives in the MCP catalog. Clients never receive it. Catalog edits do not bump `configVersion`. Config and experiment edits do.

## First actions

1. Confirm Wardx MCP tools are available. If they are not, start the server as an MCP process (see [Troubleshooting](#troubleshooting)). Do not compensate by calling `/v1/sync`.
2. Call `list_projects`. Every other tool takes `project` (the name, not the project key).
3. Call `get_project_overview` with that name, or read resource `wardx://project/{name}` — same panorama.
4. Follow [Onboarding](#onboarding) before proposing or interpreting experiments.

Tool argument details: [references/tools.md](references/tools.md). Package internals when editing code: [references/package.md](references/package.md).

## Onboarding

`overview.onboarding` is the source of truth.

If `onboarding.complete` is true, skip questions and continue.

If it is false, ask **only** about the listed gaps, then persist:

| Gap | Persist with |
| --- | --- |
| `missingDescription` | `set_project_description` |
| `undescribedRoles` | `set_role_description` |
| `undescribedKnobs` | `set_signal` (the Remote Config key) |
| `undescribedOutcomes` | `set_signal` (the metric or event name) |

Do not invent descriptions. Do not re-ask names that already have a legend. Do not describe `wardx.internal.*`, `experiment.exposure`, or `experiment.goal` — they are protocol signals and are omitted from the gap lists.

A predefined `catalog` in the server config can make onboarding complete on the first read. Both that and live MCP onboarding are valid. If a new undescribed name or role appears later, onboarding reopens for **that gap only**.

`path` and `git` on a role are optional source hints (`path` = checkout on this machine, `git` = repository URL). Use them when present to inspect or edit that surface. Do not ask for them. Do not invent them. `set_role_source` only when the user supplies a path or URL.

Re-read the overview after writing catalog answers. Do not propose, enable, or interpret experiments until `onboarding.complete` is true.

## Remote Config

Knobs on the overview are existing keys you may change or experiment on. Each knob lists the `roles` that receive it (`["*"]` means every role that syncs).

- `set_config_value` — set one key and the roles that receive it. Bumps `configVersion`.
- `delete_config_value` — delete one key. Bumps `configVersion`.
- `get_config` — snapshot sent toward clients (`version`, `values`, `experiments`). No catalog.

Clients pick up a new snapshot on the next sync that still has the old version. Report the returned `version`. Do not store secrets in Remote Config.

## Experiments

Propose over **existing** knobs. `variant.values` may only contain keys that already exist and that are visible to `experiment.roles`.

Call `upsert_experiment` with:

- `id`, `enabled`, `allocation` (0–1), `salt` (new random hex when creating; keep the salt when replacing the same id), `roles`, `variants` (`key`, `weight` ≥ 0 summing to > 0, `values`)
- optional `primaryMetric` (an existing outcome name)
- optional `hypothesis` — stays on the server; clients never receive it

`set_experiment_enabled` toggles without rewriting variants. `list_experiments` and `analyze_experiment` read previously proposed definitions.

Assignment runs on the client, not the server. The server stores the definition and rolls up `experiment.exposure` / `experiment.goal` in 1-minute windows.

## Telemetry

This is in-memory development aggregation, not a production query API.

- `get_aggregates` — 1-minute windows with catalog legends. Optional `names`, `from`, `to`, `role`. Counters in a window are sums of window deltas. A gauge is the last value by timestamp. Extra series past `aggregateMaxSeriesPerMetric` increment `cardinalityDropped`.
- `get_recent_logs` — newest-first ring (`recentLogsMax`). Filter with `level`, exact `message`, exact `attrs`, `role`, `limit`. Drill here after aggregates. A stack or provider code is just another attr.
- `analyze_experiment` — definition, hypothesis, exposures and goals by variant, `primaryMetric` total.

Filter with `role` when comparing surfaces. Group answers by role. Prefer catalog descriptions over raw names. MCP does not read the envelope sink (`null` / `memory` / `ndjson`).

## Changing @wardx/server

When the task is code in `packages/server`: keep HTTP as the client path only. Control stays in `ControlService` + MCP tools. Catalog mutations persist without incrementing `version`; config and experiment mutations increment `version` and rewrite the loaded config file when `configPath` is set. See [references/package.md](references/package.md).

## Examples

**User says:** "What's going on in Wardx?"

1. `list_projects` → `get_project_overview`.
2. If onboarding is incomplete, ask only the listed gaps and persist.
3. Summarize description, knobs by role, recent outcomes, and existing experiments.

**User says:** "Set chat delay to 400ms for the client."

1. Overview first. Confirm `message.delayMs` exists and which roles receive it.
2. `set_config_value` with `key`, `value: 400`, `roles: ["client"]`.
3. Report the new `version`. Clients apply it on the next sync.

**User says:** "A/B test a shorter delay."

1. Overview. Refuse until `onboarding.complete`.
2. Propose over listed knobs only. Include `hypothesis` and `primaryMetric`.
3. `upsert_experiment`. Later `analyze_experiment` once traffic exists.

## Troubleshooting

**No Wardx MCP tools.** Cursor (or another client) must spawn `wardx-server` on stdio. Stdin is then not a TTY, so the process serves MCP. Logs go to stderr. Do not also run `npm run server` on the same port.

```json
{
  "mcpServers": {
    "wardx": {
      "command": "npx",
      "args": ["wardx-server", "./wardx-server.json"]
    }
  }
}
```

In this repo: `npx wardx-server ./config/development.json` (or `npm run server` for HTTP-only; that does not attach MCP unless stdin is not a TTY).

**`unknown project`.** Use the name from `list_projects`, not the `X-Wardx-Key` value.

**`unknown config key` / `not visible to role`.** Create the key with `set_config_value` first. Experiment `variant.values` must be a subset of keys those roles already receive.

**Tool `isError` with a message.** That string is the contract error. Fix the arguments; do not retry the same payload.

**Empty aggregates / logs.** Nothing has synced yet, or retention elapsed (`aggregateRetentionMinutes`). The log ring is not a history search.
