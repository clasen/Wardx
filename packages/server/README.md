# @wardx/server

`@wardx/server` is the Wardx ingest server.

The server receives `POST /v1/sync`. The server authenticates the project key. The server writes envelopes to a sink. The server aggregates frames into 1-minute windows per project. The server returns that project's Remote Config when the client version is not current.

HTTP is only the client path. Control, analysis, and visualization use MCP tools on the same process. There is no admin HTTP API.

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
| `sink` | `null`, `memory`, or `ndjson`. |
| `ndjsonPath` | File path. Required when `sink` is `ndjson`. |
| `maxRequestBytes` | Maximum request body size. |
| `aggregateRetentionMinutes` | Retention of 1-minute windows. |
| `aggregateMaxSeriesPerMetric` | Maximum distinct dimension sets per metric name in one 1-minute window. Further series are dropped. |
| `memorySinkMaxEnvelopes` | Maximum envelopes in the memory sink. |
| `recentClientsMax` | Maximum recent client records kept per project. |
| `recentLogsMax` | Maximum recent log rows kept per project for MCP drill-down. |
| `projects` | Object keyed by project name. Each value is a Remote Config snapshot. |

Each `projects.<name>` object requires `version`, `values`, `keyRoles`, and `experiments`. `keyRoles` maps every config key to a list of role names, or `["*"]` for every role that syncs. Optional `catalog` is MCP-only: a project `description`, `roles` (role name → `{ description }` plus optional `path` and `git`; `path` is a local checkout, `git` is a repository URL), `signals` (name → text for Remote Config keys, metrics, and events), and `experiments` hypotheses. The catalog is not sent to SDKs. Mutating it does not bump `configVersion`. Ship a predefined catalog, or leave it empty and fill it during MCP onboarding. Both are valid. Every name in `projectKeys` must exist in `projects`.

Example `wardx-server.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "projectKeys": {
    "dev_project_key": "demo"
  },
  "sink": "memory",
  "ndjsonPath": "wardx-dev.ndjson",
  "maxRequestBytes": 2097152,
  "aggregateRetentionMinutes": 60,
  "aggregateMaxSeriesPerMetric": 1000,
  "memorySinkMaxEnvelopes": 10000,
  "recentClientsMax": 100,
  "recentLogsMax": 200,
  "projects": {
    "demo": {
      "version": 1,
      "values": {
        "matchmaking.timeoutMs": 5000,
        "message.delayMs": 1000
      },
      "keyRoles": {
        "matchmaking.timeoutMs": ["game-server"],
        "message.delayMs": ["client"]
      },
      "experiments": [],
      "catalog": {
        "description": "Demo chat app. Players send messages after a configurable delay.",
        "signals": {
          "message.delayMs": "Milliseconds to wait before sending a chat message",
          "message.sent": "Chat messages that left the client after the delay"
        },
        "experiments": {}
      }
    }
  }
}
```

## HTTP interface

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/v1/sync` | `X-Wardx-Key` | Ingest frames. Return that project's config if the version changed. |
| `GET` | `/health` | None | Liveness. No telemetry. |

Sync request:

```http
POST /v1/sync
Content-Type: application/json
Content-Encoding: gzip
X-Wardx-Key: <project key>
```

Delivery is at-most-once. The server does not persist a retry queue.

## MCP interface

When Cursor or another MCP client spawns `wardx-server`, stdin is not a TTY. The process listens for sync and serves MCP on stdio. Logs go to stderr. Do not also run `npm run server` on the same port.

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

Tools take a `project` name except `list_projects`. Read `wardx://project/{name}` for the same panorama as `get_project_overview`.

| Tool | Role |
| --- | --- |
| `list_projects` | Project names on this server. |
| `get_project_overview` | Description, onboarding gaps, Remote Config knobs, telemetry outcomes, previously proposed experiments, recent clients. |
| `set_project_description` | MCP-only product description. Does not bump `configVersion`. |
| `set_role_description` | MCP-only description of one client role. Does not bump `configVersion`. |
| `set_role_source` | Optional MCP-only `path` and/or `git` for one client role. Does not bump `configVersion`. |
| `set_signal` | Document one key, metric, or event. Does not bump `configVersion`. |
| `delete_signal` | Remove one catalog signal. Does not bump `configVersion`. |
| `get_config` | Remote Config snapshot sent to clients. |
| `set_config_value` | Set one key and the roles that receive it. Bumps `configVersion`. |
| `delete_config_value` | Delete one key. Bumps `configVersion`. |
| `list_experiments` | Previously proposed experiments, with hypothesis when set. |
| `upsert_experiment` | Propose or replace an experiment over existing Remote Config keys. Optional `hypothesis` stays on the server. Bumps `configVersion`. |
| `set_experiment_enabled` | Enable or disable an experiment. Bumps `configVersion`. |
| `get_aggregates` | 1-minute windows with catalog legends. Optional `names`, `from`, `to`. |
| `get_recent_logs` | Recent log rows, newest first. Optional `level`, `message`, `attrs`, `limit`. |
| `analyze_experiment` | Definition, hypothesis, exposures, goals by variant, `primaryMetric` total. |

The SDK sends names with no descriptions. Meaning lives in the catalog. A predefined `catalog` in the config file can make `onboarding.complete` true on the first read. If it is false, the agent asks only about `missingDescription` and the listed undescribed knobs and outcomes, then writes answers with `set_project_description` and `set_signal`. It does not invent descriptions, does not re-ask names that already have a legend, and does not propose experiments until `onboarding.complete` is true.

After that, an agent reads the overview, proposes experiments on the listed knobs, and can later list or analyze those proposals. `variant.values` may only contain keys that already exist in Remote Config.

If the process loaded a config file, mutations rewrite that file so they survive a restart. Catalog edits persist without incrementing `version`. Config and experiment edits increment `version`. Clients compare the number only.

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

The process writes to stderr:

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
  role: 'client',
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

`startServer(config)` creates the server and listens. The CLI loads the path from `process.argv[2]` and calls `startServer`. When stdin is not a TTY, the CLI also starts MCP stdio.

`server.wardx` contains `config`, `registry`, `control`, and `sink`. Tests can use these objects.

You can pass a config object. You do not need a file:

```js
import { createIngestServer, listen } from '@wardx/server';

const server = createIngestServer({
  host: '127.0.0.1',
  port: 0,
  projectKeys: { 'test-key': 'demo' },
  sink: 'memory',
  maxRequestBytes: 2097152,
  aggregateRetentionMinutes: 60,
  aggregateMaxSeriesPerMetric: 1000,
  memorySinkMaxEnvelopes: 1000,
  recentClientsMax: 50,
  recentLogsMax: 100,
  projects: {
    demo: {
      version: 1,
      values: { 'message.delayMs': 1000 },
      keyRoles: { 'message.delayMs': ['client'] },
      experiments: []
    }
  }
});
const address = await listen(server, 0, '127.0.0.1');
```

## Use case 3: Ingest frames from an SDK

**When:** A Wardx client sends a gzip JSON envelope.

**Objective:** Authenticate, validate, write the sink, aggregate for that project, and respond.

Ingest order:

1. Read `X-Wardx-Key`. Map the key to a project name.
2. Read the body. Reject the body if the size is above `maxRequestBytes`.
3. Gunzip the body when `Content-Encoding` is `gzip`.
4. Parse JSON. Validate the envelope.
5. Reject the envelope if `body.project` does not match the key.
6. Write the envelope to the sink.
7. Add the frames to that project's 1-minute aggregator.
8. Record the client in that project's recent-client ring.
9. Push log rows into that project's recent-log ring.
10. If `configVersion` is not current for that project, include that role's snapshot in the response.

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

The server stores one `configVersion` per project and caches a JSON view per role. It does not rebuild config JSON per instance.

Error examples:

| Status | Condition |
| --- | --- |
| `401` | Missing or unknown `X-Wardx-Key`. |
| `400` | Invalid gzip, invalid JSON, invalid envelope, or project mismatch. |
| `413` | Body larger than `maxRequestBytes`. |

## Use case 4: Change Remote Config while clients sync

**When:** You change a value or an experiment. Clients must get the new snapshot.

**Objective:** Use MCP. Do not call HTTP.

Ask the agent to set a key or upsert an experiment on the project. Equivalent in-process call:

```js
server.wardx.control.setValue('demo', 'message.delayMs', 400, ['client']);
server.wardx.control.upsertExperiment('demo', {
  id: 'message-delay-v1',
  enabled: true,
  allocation: 1,
  salt: '3ad8f9',
  primaryMetric: 'message.sent',
  roles: ['client'],
  hypothesis: 'Shorter delay increases messages sent',
  variants: [
    { key: 'control', weight: 50, values: { 'message.delayMs': 1000 } },
    { key: 'fast', weight: 50, values: { 'message.delayMs': 400 } }
  ]
});
```

The next client sync that sends an older `configVersion` receives `config` in the response. The Node.js SDK applies that snapshot in memory.

## Use case 5: Read telemetry and analyze an experiment

**When:** You inspect counters, events, clients, or an A/B test.

**Objective:** Use MCP tools `get_aggregates`, `get_recent_logs`, `get_project_overview`, and `analyze_experiment`. Start from the overview so knobs and outcomes have catalog legends.

The aggregator merges frames by minute per project. The aggregator keeps windows for `aggregateRetentionMinutes`. Counters in a window are sums of window deltas. A gauge in a window is the last value by timestamp. Events count by name and role. Event attrs are not series. `experiment.exposure` and `experiment.goal` roll up by experiment and variant. Each metric name keeps at most `aggregateMaxSeriesPerMetric` distinct dimension sets per window. Extra series increment `cardinalityDropped` on that window.

A volume funnel is that comparison: pass the step names in `names` and compare `counters` (or `eventNames`) in one window and `role`. That is how often each step fired. The aggregator does not store sequences, unique subjects, or time between steps. Production `sink: "null"` discards envelopes after ingest, so there is no later join on `sessionId`. Instrument the steps in the SDK. See `wardx` use case 7.

`get_recent_logs` reads a per-project ring of recent log rows (`recentLogsMax`). It does not search history. Filter by `level`, `message`, and `attrs` (exact match on the listed keys). A stack or a provider code is just another attr.

This is in-memory development aggregation. This is not a query API for production analytics.

## Use case 6: Select a sink

**When:** You choose where envelopes go.

**Objective:** Set `sink` in the config file.

| Value | Behavior |
| --- | --- |
| `null` | Discard envelopes. Production and ingest benchmarks. MCP does not read this store. |
| `memory` | Keep envelopes in an array. Drop the oldest envelope above `memorySinkMaxEnvelopes`. Local debugging. |
| `ndjson` | Append one JSON object per line to `ndjsonPath`. Local debugging. |

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
| `ControlService` | In-process control for config, experiments, and aggregates. |
| `executeTool` | MCP tool handlers used by tests and stdio. |
| `FrameAggregator` | 1-minute in-memory aggregation. |
| `ConfigRepository` | Stores one config snapshot. |
| `NullSink`, `MemorySink`, `NdjsonSink` | Envelope destinations. |

## Related packages

- Node.js SDK: `wardx`
- Engine: `@wardx/core`
