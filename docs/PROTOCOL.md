# Wardx Sync Protocol v1

Wire contract for the Node SDK and ingest server. Future SDKs must emit and consume this envelope unchanged.

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
    "appVersion": "2.4.1",
    "environment": "production",
    "platform": "node"
  },
  "configVersion": 12,
  "frames": []
}
```

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

Counters are **window deltas**, not lifetime totals. Histogram observations above the last bound remain in `count` / `sum` / `min` / `max` and do not increment a bucket. Internal SDK series use the `wardx.internal.` prefix and are merged into the same arrays.

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

The server stores one serialized snapshot per version. A request only compares `configVersion`; it does not rebuild config JSON per client.

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

Ingest process: authenticate `X-Wardx-Key` → gunzip if needed → parse → validate → sink → 1-minute in-memory aggregation → compare config version → respond.

Admin (separate credential `X-Wardx-Admin-Key`):

- `PUT /v1/admin/config`
- `GET /v1/admin/config`
- `GET /v1/admin/aggregates`
- `GET /health`
