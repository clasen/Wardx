---
name: wardx-server
description: Operates the Wardx ingest control plane over MCP — catalog onboarding, Remote Config, experiments, 1-minute aggregates, recent logs, volume-funnel reads, and economy-jump investigation (histogram max vs a Remote Config cap). Use when the user mentions Wardx, wardx-server, @wardx/server, Remote Config, experiments, ingest, telemetry, funnel, fraud, economy leak, get_project_overview, set_config_value, upsert_experiment, analyze_experiment, POST /v1/sync, or MCP tools on the Wardx process. Also use when changing packages/server (ControlService, ingest, MCP tools, config schema). Do not use for writing SDK instrumentation (metrics, events, config.get) — that belongs to wardx, wardx-unity, or wardx-csharp.
---

# Wardx server

One process, two doors. There is no admin HTTP API.

- **Clients** speak `POST /v1/sync` (frames up, that role's Remote Config down).
- **Agents** speak MCP on the same process (tools + `wardx://project/{name}`).

A project is one product. Each SDK instance declares a `role` (`backend`, `frontend`, `desktop`, `unity`, …). Roles share the project; series stay separate by role. A sync downloads only keys and experiments visible to that instance's role. The project key authenticates the project; the client chooses `role`, so role filtering is routing metadata, not authorization. Never put secrets in Remote Config.

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

- `id`, `enabled`, `allocation` (0–1), `salt` (new random hex when creating; keep the salt when replacing the same id), `goalMetric`, `roles`, `variants` (`key`, `weight` ≥ 0 summing to > 0, `values`)
- optional `primaryMetric` (an existing outcome name)
- optional `hypothesis` — stays on the server; clients never receive it
- for a closable test: `goalKind` (`conversion` or `mean`), `control` (a variant key), `minExposures` (integer ≥ 1; ≥ 2 when `mean`), `confidence` (number in (0, 1)). No implicit defaults. These fields never go to clients.

`set_experiment_enabled` toggles without rewriting variants. It does not ship a winner. `list_experiments` and `analyze_experiment` read previously proposed definitions. `ship_experiment` copies the winning `variant.values` into Remote Config and sets `enabled` false. Call it only when `decision.status` is `winner` (or the experiment is already shipped). Omit `variant` to ship `leadingVariant`.

Assignment runs on the client, not the server. The server stores the definition and rolls up an exposure and only the goal whose name equals that experiment's `goalMetric` into lifetime totals. Those totals survive the 1-minute window retention and, when a config file is loaded, persist to `<configPath>.experiment-stats.json`. There is no legacy goal-matching fallback. Clients call `identify()` / `Identify()` on a single-user process, or pass `subjectId` per call on a multi-user process (wardx, wardx-unity, or wardx-csharp). A read with no subject returns Remote Config and does not expose. Keep the `salt` when replacing the same `id`; a new salt redistributes the population. Do not change variant weights to "roll out" a winner — that remaps existing subjects. Ship instead.

## Telemetry

Wardx is aggregate-first, not a per-subject query API. 1-minute windows persist to `<configPath>.aggregate-windows.json` when a config file is loaded and expire exactly at `aggregateRetentionMinutes`. The recent-client and recent-log rings are bounded and volatile. Only experiment totals and allowlisted persist-log totals have their documented lifetime rollups. Do not infer journeys, unique users, per-account history, a ledger, or general multi-day analytics. A delayed follow-up requires an external scheduler or automation to invoke the agent later.

- `get_aggregates` — 1-minute windows with catalog legends. Optional `names`, `from`, `to`, `role`. Counters in a window are sums of window deltas. A gauge is the last value by timestamp. Events count by name and role; attrs are not series. Histogram `max` and `exemplar` are the window peak (a lookup key, not a player). Extra series past `aggregateMaxSeriesPerMetric` increment `cardinalityDropped`. Catalog `persistLogs` names appear as `logNames` (`count` + last exemplar by role and level). Windows persist across restart for `aggregateRetentionMinutes`.
- Volume funnel — compare step counter totals (or `eventNames`) for the same window and `role`. That is how often each step fired, not unique users and not ordered sequences. Do not invent a per-subject path. Point missing step names at the matching SDK skill (wardx, wardx-unity, or wardx-csharp).
- Economy jump — overview histogram outcomes are ranked by `max`. Compare that `max` to a numeric cap knob (`economy.maxAward` or similar). Then `get_aggregates` on the amount, count, and size names, and `get_recent_logs` with the anomaly message or `exemplar.attrs` (`grantId`, `source`, `reason`). Fleet signal, not a player to punish. The wallet row is in the application database. Missing names → matching SDK skill (wardx use case 8, or wardx-unity / wardx-csharp).
- `get_recent_logs` — newest-first ring (`recentLogsMax`). Filter with `level`, exact `message`, exact `attrs`, `role`, `limit`. Drill here after aggregates. A stack or provider code is just another attr.
- Persist logs — `set_persist_log` adds an exact message name to `catalog.persistLogs`. The server keeps a lifetime count and last exemplar for that name (`kind: "log"` on the overview, sidecar `<configPath>.log-stats.json`). `delete_persist_log` removes it. Names not on the list stay in the ring only. Do not put free-text messages on this list.
- `analyze_experiment` — definition, hypothesis, lifetime `exposures` / `goals` / `goalSum` / `goalSumSq` / `goalMean` / `rate` by variant, `primaryMetric` fleet total, and `decision`. `rate` is `goals / exposures`. For `goalKind: mean` compare `goalMean`. For `goalKind: conversion` compare `rate` — `goalMean` is 1 when every goal sends `value: 1`. `decision.status` is `collecting`, `winner`, `no_difference`, `cannot_decide`, or `shipped`. Do not call a variant the winner unless status is `winner` or `shipped`. `experiment.goal` is one conversion or one value, not an N-step funnel. One experiment should have one quantitative goal name. `primaryMetric.total` is not split by variant.

Filter with `role` when comparing surfaces. Group answers by role. Prefer catalog descriptions over raw names. MCP does not read the envelope sink (`null` / `memory` / `ndjson`).

## Production boundary

Keep the Node listener behind a reverse proxy. The proxy owns TLS, coarse request-rate limits, compressed-body limits, finite timeouts, trusted-forwarded-header behavior, and traffic drain. It must not retry `POST /v1/sync` or log keys/bodies/subject IDs. Wardx independently bounds compressed and decoded bodies. `GET /health` is liveness only, not readiness.

Rotate keys with overlap: add the new key, rolling-restart all replicas, migrate clients, then remove the old key and rolling-restart again. Config files, sidecars, and backups require service-account-only permissions. Structured diagnostics must redact credentials, bodies, subjects, and Remote Config values.

Corrupt config or sidecars stop startup; never delete corrupt data to make the process boot. For backup, drain and `await server.wardx.stop()`, then copy the config plus every existing `.experiment-stats.json`, `.log-stats.json`, and `.aggregate-windows.json` sidecar as one set and record legitimate absence. Restore the complete set. Upgrade with a pre-upgrade snapshot; rollback restores the previous binary and that snapshot because no storage compatibility fallback is implied. See the server README's production operations section for authority, capacity, and recovery details.

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

**User says:** "How is the onboarding funnel?"

1. Overview. Confirm the step names exist as outcomes.
2. `get_aggregates` with those names and the client `role`. Compare counts start → next → done in the same window.
3. If they expected unique-user sequences or time between steps, say Wardx does not store that.

**User says:** "A/B test a shorter delay."

1. Overview. Refuse until `onboarding.complete`.
2. Propose over listed knobs only. Include `hypothesis`, `primaryMetric`, the exact conversion name as `goalMetric`, `goalKind: 'conversion'`, `control`, `minExposures`, and `confidence`.
3. `upsert_experiment`. Later `analyze_experiment` once traffic exists. Follow `decision.status`. Ship with `ship_experiment` only when status is `winner`.
4. If exposures stay at zero, the app is reading the knob with no subject. Point them at the matching SDK skill: `identify()` / `Identify()` on a single-user process, or `subjectId` on each `config.get` / `Config.Get` / `experiment.goal` / `Experiment.Goal` on a multi-user process.

**User says:** "Levels feel too hard. Run an A/B to increase session time."

1. Overview. Refuse until `onboarding.complete`. Confirm difficulty knobs exist (`level.*.enemyHp` or similar) and that `session.time_ms` / `session.duration` are outcomes. Missing names → matching SDK skill (wardx use cases 14 and 15, or wardx-unity / wardx-csharp).
2. `get_aggregates` on `level.start`, `level.fail`, `level.complete`, `session.time_ms`. Funnel counts are the difficulty signal. `session.time_ms` is fleet play time.
3. `upsert_experiment` on those knobs. `hypothesis` such as "Lower HP on level 3 increases session duration". `primaryMetric: 'session.time_ms'`, `goalMetric: 'session.duration'`, `goalKind: 'mean'`, `control`, `minExposures`, `confidence`.
4. Later `analyze_experiment`: follow `decision`. Compare `goalMean` for the duration goal. Do not treat `primaryMetric.total` as a per-variant mean. `ship_experiment` when `decision.status` is `winner`.

**User says:** "There are errors — go fix the file."

1. `get_aggregates` for the error counter. Then `get_recent_logs` with `level: 'error'` and the message. Read `attrs.stack` / `attrs.code`.
2. If that role has `path` or `git`, open that checkout and edit with your file tools. Wardx does not change application code.
3. If `path` and `git` are empty, say so. Do not invent a path. `set_role_source` only when the user supplies one.

**User says:** "Points are jumping / is the economy leaking / is there fraud?"

1. Overview. Find the cap knob (`economy.maxAward` or similar). Find histogram outcomes (`coins.award_size` or similar): `max` vs that cap, `exemplar.attrs` (`grantId`, `source`, `reason`). Note `*.anomaly` events.
2. `get_aggregates` with the amount counter, grant counter, size histogram, and anomaly event. Mean grant is amount / grants. Upper buckets and `max` are the jump.
3. `get_recent_logs` with the anomaly message (`coins_anomaly`) or `attrs` from the exemplar (`grantId`, `source`).
4. If that role has `path` or `git`, open that checkout and search the grant path (`source`, `reason`). Wardx does not change application code. The wallet row is in the game database.
5. Do not treat this as a player to punish. The question is whether a grant path exceeds the cap. Missing names → matching SDK skill (wardx use case 8, or wardx-unity / wardx-csharp).

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

**Experiment has no exposures.** The definition reached clients, but those processes are reading the knob with no subject. On a single-user process they should `identify()`. On a `game-server` they should pass `{ subjectId }` per call.
