# @wardx/server

`@wardx/server` is the Wardx ingest server.

The server receives `POST /v1/sync`. The server authenticates the project key. The server writes envelopes to a sink. The server aggregates frames into 1-minute windows. The server returns Remote Config when the client version is not current.

Node.js 20 or later is required.

Install this package from npm. The published package does not include a config file. You must supply a JSON config file.

## Install

```bash
npm install @wardx/server
```

```js
import { createIngestServer, listen, startServer, loadServerConfig } from '@wardx/server';
```

The CLI name is `wardx-server`.

## Config file

Pass the JSON file path as the CLI argument. The loader does not add a fallback for a missing path.

Required keys:

| Key | Description |
| --- | --- |
| `host` | Bind address. |
| `port` | Bind port. Use `0` to let the OS select a port. |
| `projectKeys` | Object that maps a project key to a project name. |
| `adminKey` | Value of header `X-Wardx-Admin-Key`. |
| `sink` | `null`, `memory`, or `ndjson`. |
| `ndjsonPath` | File path. Required when `sink` is `ndjson`. |
| `maxRequestBytes` | Maximum request body size. |
| `aggregateRetentionMinutes` | Retention of 1-minute windows. |
| `memorySinkMaxEnvelopes` | Maximum envelopes in the memory sink. |
| `config.version` | Remote Config version. |
| `config.values` | Remote Config values. |
| `config.experiments` | Experiment list. |

Example `wardx-server.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "projectKeys": {
    "dev_project_key": "demo"
  },
  "adminKey": "dev_admin_key",
  "sink": "memory",
  "ndjsonPath": "wardx-dev.ndjson",
  "maxRequestBytes": 2097152,
  "aggregateRetentionMinutes": 60,
  "memorySinkMaxEnvelopes": 10000,
  "config": {
    "version": 1,
    "values": {
      "matchmaking.timeoutMs": 5000,
      "message.delayMs": 1000
    },
    "experiments": []
  }
}
```

## HTTP interface

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/v1/sync` | `X-Wardx-Key` | Ingest frames. Return config if the version changed. |
| `GET` | `/health` | None | Health check. |
| `GET` | `/v1/admin/config` | `X-Wardx-Admin-Key` | Read the current snapshot. |
| `PUT` | `/v1/admin/config` | `X-Wardx-Admin-Key` | Replace the snapshot. |
| `GET` | `/v1/admin/aggregates` | `X-Wardx-Admin-Key` | Read 1-minute aggregates. |

Sync request:

```http
POST /v1/sync
Content-Type: application/json
Content-Encoding: gzip
X-Wardx-Key: <project key>
```

Delivery is at-most-once. The server does not persist a retry queue.

## Use case 1: Start the ingest server from npm

**When:** You need a local or development ingest endpoint for the `wardx` SDK.

**Objective:** Listen on a host and port with your config file.

### Procedure

1. Install `@wardx/server`.
2. Write a JSON config file. See the example above.
3. Pass the file path to the CLI.

```bash
npm install @wardx/server
npx wardx-server ./wardx-server.json
```

The process writes:

```text
wardx ingest listening on 8787
```

4. Point the Node.js SDK to the server.

```js
import { createWardx } from 'wardx';

const wardx = createWardx({
  endpoint: 'http://127.0.0.1:8787',
  projectKey: 'dev_project_key',
  project: 'demo',
  appVersion: '0.1.0',
  environment: 'development'
});
```

The project key in `createWardx` must exist in `projectKeys`. The project name must match the mapped value.

## Use case 2: Start the server in a process

**When:** You embed the ingest server in a test or in your process.

**Objective:** Create the server, listen, then close.

```js
import { createIngestServer, listen, loadServerConfig } from '@wardx/server';

const config = loadServerConfig('./wardx-server.json');
const server = createIngestServer(config);
const address = await listen(server, config.port, config.host);

console.log(`listening on ${address.port}`);

server.close();
```

`startServer(config)` creates the server and listens. The CLI loads the path from `process.argv[2]` and calls `startServer`.

`server.wardx` contains `config`, `configRepo`, `aggregator`, and `sink`. Tests can use these objects.

You can pass a config object. You do not need a file:

```js
import { createIngestServer, listen } from '@wardx/server';

const server = createIngestServer({
  host: '127.0.0.1',
  port: 0,
  projectKeys: { 'test-key': 'demo' },
  adminKey: 'admin-key',
  sink: 'memory',
  maxRequestBytes: 2097152,
  aggregateRetentionMinutes: 60,
  memorySinkMaxEnvelopes: 1000,
  config: {
    version: 1,
    values: { 'message.delayMs': 1000 },
    experiments: []
  }
});
const address = await listen(server, 0, '127.0.0.1');
```

## Use case 3: Ingest frames from an SDK

**When:** A Wardx client sends a gzip JSON envelope.

**Objective:** Authenticate, validate, write the sink, aggregate, and respond.

Ingest order:

1. Read `X-Wardx-Key`. Map the key to a project name.
2. Read the body. Reject the body if the size is above `maxRequestBytes`.
3. Gunzip the body when `Content-Encoding` is `gzip`.
4. Parse JSON. Validate the envelope.
5. Reject the envelope if `body.project` does not match the key.
6. Write the envelope to the sink.
7. Add the frames to the 1-minute aggregator.
8. If `configVersion` is not current, include the snapshot in the response.

Same version:

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

The server stores one serialized snapshot per version. The server does not rebuild config JSON per client.

Error examples:

| Status | Condition |
| --- | --- |
| `401` | Missing or unknown `X-Wardx-Key`. |
| `400` | Invalid gzip, invalid JSON, invalid envelope, or project mismatch. |
| `413` | Body larger than `maxRequestBytes`. |

## Use case 4: Change Remote Config while clients sync

**When:** You change a value or an experiment. Clients must get the new snapshot.

**Objective:** Replace the snapshot with `PUT /v1/admin/config`.

```bash
curl -sS -X PUT http://127.0.0.1:8787/v1/admin/config \
  -H 'content-type: application/json' \
  -H 'X-Wardx-Admin-Key: dev_admin_key' \
  -d '{
    "version": 2,
    "values": {
      "matchmaking.timeoutMs": 3000,
      "message.delayMs": 400
    },
    "experiments": []
  }'
```

Read the snapshot:

```bash
curl -sS http://127.0.0.1:8787/v1/admin/config \
  -H 'X-Wardx-Admin-Key: dev_admin_key'
```

The next client sync that sends an older `configVersion` receives `config` in the response. The Node.js SDK applies that snapshot in memory.

Increment `version` when you replace the snapshot. Clients compare the number only.

## Use case 5: Read 1-minute aggregates

**When:** You inspect counters, gauges, histograms, event counts, and log counts.

**Objective:** Call `GET /v1/admin/aggregates`.

```bash
curl -sS http://127.0.0.1:8787/v1/admin/aggregates \
  -H 'X-Wardx-Admin-Key: dev_admin_key'
```

The aggregator merges frames by minute. The aggregator keeps windows for `aggregateRetentionMinutes`. Counters in a window are sums of window deltas. A gauge in a window is the last value by timestamp.

This endpoint is for development. This endpoint is not a query API for production analytics.

## Use case 6: Select a sink

**When:** You choose where envelopes go.

**Objective:** Set `sink` in the config file.

| Value | Behavior |
| --- | --- |
| `null` | Discard envelopes. Use this sink for ingest benchmarks. |
| `memory` | Keep envelopes in an array. Drop the oldest envelope above `memorySinkMaxEnvelopes`. |
| `ndjson` | Append one JSON object per line to `ndjsonPath`. |

Programmatic sinks:

```js
import { NullSink, MemorySink, NdjsonSink } from '@wardx/server';

const nullSink = new NullSink();
const memorySink = new MemorySink({ memorySinkMaxEnvelopes: 10000 });
const ndjsonSink = new NdjsonSink({ ndjsonPath: 'wardx-dev.ndjson' });
```

`createIngestServer` constructs the sink from `config.sink`. You do not pass a sink object to `createIngestServer`.

## Exports

| Export | Function |
| --- | --- |
| `createIngestServer(config)` | Creates an `http.Server`. |
| `listen(server, port, host)` | Listens and returns `server.address()`. |
| `startServer(config)` | Creates the server and listens. |
| `loadServerConfig(path)` | Reads and validates a JSON file. |
| `FrameAggregator` | 1-minute in-memory aggregation. |
| `ConfigRepository` | Stores one config snapshot. |
| `NullSink`, `MemorySink`, `NdjsonSink` | Envelope destinations. |

## Related packages

- Node.js SDK: `wardx`
- Engine: `@wardx/core`
