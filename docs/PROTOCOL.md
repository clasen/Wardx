# Wardx Sync Protocol v1

Wire contract for Wardx SDKs and the ingest server. Every SDK must emit and consume this envelope unchanged. `sdk.name` / `client.platform` identify the runtime: `wardx-node` / `node`, `wardx-csharp` / `csharp`, `wardx-unity` / `unity`.

## Transport

```http
POST /v1/sync
Content-Type: application/json
Content-Encoding: gzip
X-Wardx-Key: <project key>
```

General telemetry delivery is **at-most-once**. A failed sync discards the batch;
there is no client disk queue and no retry of the same frames. Experiment
exposure/goal evidence is the explicit exception: the server transactionally
commits accepted deduplicated evidence before returning success.

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

`client.instanceId` and `client.sessionId` belong to one SDK instance. Starting another SDK instance in the same process creates another pair; neither identifier is a process-wide singleton or a subject/journey key.

`client.role` is a non-empty name for this SDK instance inside the project:
`backend`, `frontend`, `desktop`, `unity`, and so on. `*` is reserved and
rejected. The credential record authenticates the project and declares the
roles that key may claim; a valid but out-of-scope role receives `403`. Several
roles may sync to the same project and similar metric names remain separate.
Role-filtered Remote Config is still not a secret store.

`frames` may be empty on bootstrap so the client can fetch Remote Config immediately.

The envelope is closed-schema: unknown top-level, `sdk`, `client`, frame, metric, histogram, exemplar, event, and log fields are rejected. The server also enforces `maxFramesPerEnvelope`, the combined `maxItemsPerEnvelope`, `maxNameBytes`, `maxDimensionKeys`, `maxDimensionValueLength`, `maxAttributeKeys`, `maxAttributeValueLength`, and `maxClockSkewMs` from its required configuration. Values and timestamps must be finite; tuples, dimensions, attributes, histogram bounds/counts/totals, and log levels must have the shapes below. Validation completes before the sink, aggregate state, rings, or persistence are mutated.

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
    ]],
    "distincts": [[
      "shot.traffic.hids",
      {"result":"violating"},
      {"precision":9,"registers":"<canonical base64 of 512 registers>"}
    ]]
  },
  "events": [[1787221124812, "purchase", {"product":"premium"}]],
  "logs": [[1787221125823, "error", "payment_failed", {"code":"timeout"}]]
}
```

The server counts `events` by name and `client.role`. Attrs on a product event are not series. `experiment.exposure` and `experiment.goal` are the exception: they roll up by experiment and variant. A volume funnel is therefore one distinct event name (and a counter of the same name) per step. See [ARCHITECTURE.md](ARCHITECTURE.md).

Counters are **window deltas**, not lifetime totals. Histogram observations above the last bound remain in `count` / `sum` / `min` / `max` and do not increment a bucket.

`distincts` is optional when empty. Each row is a fixed HyperLogLog sketch with
`precision = 9` and exactly 512 one-byte registers encoded as canonical Base64.
Clients compute SHA-256 over `privacySalt`, one zero byte, and the UTF-8
identifier, update one register, and discard the identifier and digest. Servers
merge sketches by the register-wise maximum. The standard error is about 4.6%.
Deploy server support before enabling `distinct` in an SDK: version 1 frames
without `distincts` remain unchanged, while an older closed-schema server rejects
the new collection.

A histogram body may include optional `exemplar`: `{ "value": 80, "attrs": { "grantId": "g-80" } }`. It is the observation that set `max` in that window, with caller attrs. One exemplar per series per window. The server keeps the exemplar of the higher merged `max`. Clients omit the field when the max observation had no attrs.

Internal SDK series use the `wardx.internal.` prefix and are merged into the same arrays.

SDKs measure the serialized UTF-8 JSON and split a logical snapshot into physical frames no larger than `maxFrameBytes`, with consecutive `seq` values. The setting is at least `1024`. A single row that cannot fit in an empty frame is dropped and counted by `wardx.internal.frame_rows_dropped`; the SDK never sends an oversized frame silently.

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

Error responses use `{ "ok": false, "error": "..." }`:

| Status | Meaning |
| --- | --- |
| `400` | Malformed gzip/JSON/protocol data, invalid fields, or project mismatch. |
| `401` | Missing or unknown `X-Wardx-Key`. |
| `403` | The authenticated credential cannot claim `client.role`. |
| `404` | Route or method not found. |
| `413` | Compressed request body or decoded envelope exceeds `maxRequestBytes`. |
| `415` | Unsupported `Content-Encoding`. |
| `503` | A configured sync or persistence capacity bound is full. The response is non-sensitive. |
| `500` | Non-sensitive internal failure. Details go only to the configured diagnostic sink. |

Only an absent/identity encoding and `gzip` are supported. Proxies must not transform an unsupported encoding into an accepted one.

## Experiment assignment

UTF-8 FNV-1a 32-bit:

```text
hash = fnv1a32(experimentId + ':' + subjectId + ':' + salt)
bucket = hash / 2^32          # [0, 1)
```

If `bucket >= allocation`, the subject is not in the experiment and receives the Remote Config value.

Otherwise variants are chosen from cumulative `weight / totalWeight * allocation` thresholds. Exposure is emitted once per session as event `experiment.exposure` with a hashed subject, never the raw `subjectId`.

Every experiment snapshot has one non-empty `goalMetric`. A goal is emitted only for an assignment already exposed in this SDK instance and only when the goal call's name equals that assignment's `goalMetric`. One call cannot attach unrelated concurrent experiments, and there is no match-all behavior. Assignment/exposure state is bounded by the SDK's required `experimentStateMaxSubjects` setting (default `100000`); eviction may emit a duplicate exposure, which the server ledger counts without changing accepted totals.

`subjectHash = SHA-256(UTF8(projectSalt) || 0x00 || UTF8(subjectId))` as 64 lowercase hex digits. The separator prevents ambiguous concatenation. Node and C# require an explicit non-empty `privacySalt`; they never reuse the project credential. Both implementations use the same bytes and output.

Distinct sketches use the same salted SHA-256 byte construction but never put
the 256-bit digest on the wire. `privacySalt` must remain stable and identical
across workers so repeated identifiers update the same HLL register.

## Config resolution

```text
identify(subjectId)               # instance default; identify(null) clears
config.get(key, fallback, context)
  missing remote key              -> fallback
  no subject (identify unset, no context.subjectId) -> remote value
  key not in an enabled experiment -> remote value
  subject not allocated           -> remote value
  allocated                       -> variant value + async exposure
```

A per-call `context.subjectId` overrides `identify()`. `identify()` changes the default on that SDK instance. A process that serves many users must pass `subjectId` on each call instead of sharing one instance default.

## Intervals

Client operational values live in `packages/core/defaults.json`. Sync delay is `syncIntervalMs * random(syncJitterMin, syncJitterMax)`, recomputed every cycle.

## Server

Ingest process: authenticate `X-Wardx-Key` → map it to a project → bound and
decode the body → validate the envelope → authorize `client.role` → preflight
historical and experiment capacity → transactionally accept experiment evidence
when present → update the sink/current in-memory aggregates and coalesced minute
history → compare that project's config version → respond.

HTTP:

- `POST /v1/sync`
- `GET /health`

`GET /health` proves only that the process can answer HTTP at that moment. It
does not prove SQLite writability, durable persistence, Remote Config
correctness, downstream reachability, or capacity, and it is not a readiness
contract.

Remote Config, experiments, aggregates, recent events/logs, and analysis are MCP tools on the ingest process, exposed over stdio or optional loopback-only Streamable HTTP. There is no admin REST API. Each project has its own snapshot, aggregator, and bounded recent-client/event/log rings. Catalog signal entries contain a required description and optional category; this metadata is attached by name at read time and never enters ingest frames or stored aggregate series. Overview, current aggregates, and historical aggregates accept an exact category filter. `get_recent_events` retains only names explicitly listed in that project's `catalog.inspectEvents` and returns their raw attrs and instance IDs newest-first with exact name, role, and scalar-attribute filters. Its `recentEventsMax` buffer is memory-only, evicts the oldest retained rows, and is empty after restart. Events outside the allowlist still increment current and historical aggregate counts, which never contain attrs or instance IDs. Aggregates, clients, events, and logs are tagged with the sender's role. MCP `get_project_overview` groups aggregate outcomes and clients by role and exposes the active categories and inspection allowlist.

How the SDK HTTP sync and the MCP agent share that process: [ARCHITECTURE.md](ARCHITECTURE.md).
