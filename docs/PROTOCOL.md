# Wardx Sync Protocol v1

Wire contract for Wardx SDKs and the ingest server. Every SDK must emit and consume this envelope unchanged. `sdk.name` / `client.platform` identify the runtime: `wardx-node` / `node`, `wardx-csharp` / `csharp`, `wardx-unity` / `unity`.

## Transport

```http
POST /v1/sync
Content-Type: application/json
Content-Encoding: gzip
X-Wardx-Key: <project key>
```

Delivery is **at-most-once**. A failed sync discards the batch. There is no disk queue and no retry of the same frames.

## Request

```json
{
  "protocol": 1,
  "project": "demo",
  "sdk": { "name": "wardx-node", "version": "0.1.0" },
  "client": {
    "instanceId": "01…",
    "sessionId": "01…",
    "role": "client",
    "appVersion": "2.4.1",
    "environment": "production",
    "platform": "node"
  },
  "configVersion": 12,
  "frames": []
}
```

`client.role` is a non-empty name for this SDK instance inside the project: `unity`, `game-server`, `desktop`, `mobile`, and so on. It is not a closed list. `*` is reserved and rejected. Several roles may sync to the same project. They may emit similar metric names; the server keeps series separate by role.

`frames` may be empty on bootstrap so the client can fetch Remote Config immediately.

## Frame

Compact arrays for high-volume collections:

```json
{
  "seq": 42,
  "from": 1787221120000,
  "to": 1787221135000,
  "metrics": {
    "counters": [["match.completed", {"mode":"ranked"}, 18392]],
    "gauges": [["players.online", null, 12921, 1787221134000]],
    "histograms": [[
      "request.duration",
      null,
      {
        "count": 10,
        "sum": 420,
        "min": 3,
        "max": 80,
        "buckets": [[10, 2], [25, 5], [50, 2]]
      }
    ]]
  },
  "events": [[1787221124812, "purchase", {"product":"premium"}]],
  "logs": [[1787221125823, "error", "payment_failed", {"code":"timeout"}]]
}
```

The server counts `events` by name and `client.role`. Attrs on a product event are not series. `experiment.exposure` and `experiment.goal` are the exception: they roll up by experiment and variant. A volume funnel is therefore one distinct event name (and a counter of the same name) per step. See [ARCHITECTURE.md](ARCHITECTURE.md).

Counters are **window deltas**, not lifetime totals. Histogram observations above the last bound remain in `count` / `sum` / `min` / `max` and do not increment a bucket.

A histogram body may include optional `exemplar`: `{ "value": 80, "attrs": { "grantId": "g-80" } }`. It is the observation that set `max` in that window, with caller attrs. One exemplar per series per window. The server keeps the exemplar of the higher merged `max`. Clients omit the field when the max observation had no attrs.

Internal SDK series use the `wardx.internal.` prefix and are merged into the same arrays.

## Response

Same config version:

```json
{ "ok": true, "serverTime": 1787221135102, "configVersion": 12 }
```

Newer snapshot:

```json
{
  "ok": true,
  "serverTime": 1787221135102,
  "configVersion": 13,
  "config": {
    "values": { "message.delayMs": 1000 },
    "experiments": []
  }
}
```

The response `config` contains only keys and experiments visible to `client.role`. Each stored key has `keyRoles`: a list of role names, or `["*"]` for every role. Each stored experiment has `roles` with the same shape. Those lists stay on the server. MCP reads them. The wire snapshot does not include them.

The server keeps one `configVersion` per project. It caches one JSON view per role and reuses it. It does not rebuild JSON per instance.

## Experiment assignment

UTF-8 FNV-1a 32-bit:

```text
hash = fnv1a32(experimentId + ':' + subjectId + ':' + salt)
bucket = hash / 2^32          # [0, 1)
```

If `bucket >= allocation`, the subject is not in the experiment and receives the Remote Config value.

Otherwise variants are chosen from cumulative `weight / totalWeight * allocation` thresholds. Exposure is emitted once per session as event `experiment.exposure` with a hashed subject, never the raw `subjectId`.

`subjectHash = fnv1a32(projectSalt + ':' + subjectId)` as 8 lowercase hex digits. The Node SDK uses `privacySalt` from `createWardx`, or the project key when `privacySalt` is omitted.

## Config resolution

```text
config.get(key, fallback, context)
  missing remote key              -> fallback
  no subjectId                    -> remote value
  key not in an enabled experiment -> remote value
  subject not allocated           -> remote value
  allocated                       -> variant value + async exposure
```

## Intervals

Client operational values live in `packages/core/defaults.json`. Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`, recomputed every cycle.

## Server

Ingest process: authenticate `X-Wardx-Key` → map key to project → gunzip if needed → parse → validate → sink → 1-minute in-memory aggregation for that project → compare that project's config version → respond.

HTTP:

- `POST /v1/sync`
- `GET /health`

Remote Config, experiments, aggregates, recent logs, and analysis are MCP tools on the ingest process. There is no admin HTTP API. Each project has its own snapshot, aggregator, recent-client ring, and recent-log ring. Aggregates, clients, and logs are tagged with the sender's role. MCP `get_project_overview` groups them by role.

How the SDK HTTP sync and the MCP agent share that process: [ARCHITECTURE.md](ARCHITECTURE.md).
