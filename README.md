# Wardx

To find out what your own product is doing, you set up five services: analytics in one, remote config in another, experiments in a third, logs wherever they land. Then you paste IDs by hand between dashboards that don't talk to each other. One server is enough for that, and Wardx is that server. Your Unity app and your Node backend send it events, metrics and errors as they happen, and get back the configuration meant for them: the app sees its variables, the backend sees its own. You run it on a server you control, and all your projects live inside it, kept apart from each other. If you have ever dumped a CSV or a JSON export into a chat to read behavior out of it, this is the next step.

Hand what that server collects to an agent and it sees the current retained aggregate windows, allowlisted recent event/log samples, selected lifetime rollups, and the config running right now. Ask it where an onboarding volume funnel drops and it answers from aggregate counts. Show it a fleet-level reward spike and it points at the instrumented grant path. Wardx does not store per-account journeys or act as a ledger.

The same channel that carries the data up carries the configuration back down, so an agent can change a variable, turn it into a hypothesis, and inspect the resulting experiment totals. Wardx does not schedule a later agent run: delayed follow-up requires an external scheduler or automation. Remote Config is for non-secret runtime values only.

```text
                         AGENT
                  arisa.sh / Codex / Claude
                             │
             MCP stdio or Streamable HTTP
                  over an SSH tunnel
                    tools + wardx://project/{name}
                             ▼
┌─────────────────────────────────────────────────────┐
│              wardx-server (one process)             │
│              N isolated projects                    │
│                                                     │
│   MCP ──> ControlService                            │
│              ├── Remote Config snapshot             │
│              ├── Experiment definitions             │
│              ├── Aggregates                         │
│              ├── Recent events                      │
│              ├── Recent logs                        │
│              └── Catalog                            │
│                                                     │
│   HTTP POST /v1/sync                                │
│        ├── envelope store (config.sink)             │
│        │     null | memory | ndjson                 │
│        └── per-project ingest                       │
│              aggregator, recent events/logs, clients│
│              config reply filtered by client.role   │
└─────────────────────────────────────────────────────┘
                             ▲
                             │
             frames up / that role's config down
          ┌──────────────────┴──────────────────┐
          ▼                                     ▼
   Node SDK                          C# / Unity SDK
   wardx / @wardx/core               clients/csharp
   role: backend                     role: frontend
   metrics / config.get              same /v1/sync
```

HTTP sync is the client path. Control, analysis, and visualization use MCP on
the same process, either over stdio or an optional loopback-only Streamable HTTP
listener reached through an SSH tunnel. There is no admin REST API. The project
key authenticates a project; client-selected roles only route and separate data
inside it and are not an authorization boundary.

Bind metric handles once per client and stable dimension set, then reuse them in
callbacks. In Unity and C#, keep `ICounter`, `IGauge`, `IHistogram`, and `IDistinct`
as fields; enums are optional. See the [Node pattern](packages/node/README.md#recommended-bind-once-measure-through-handles)
and [C# / Unity pattern](clients/csharp/README.md#recommended-keep-handles-as-fields).

## Packages

| Package | Role |
| --- | --- |
| [`@wardx/server`](packages/server/README.md) | That server. Ingest, Remote Config, experiments, MCP. |
| [`wardx`](packages/node/README.md) | Node.js SDK. |
| [C# / Unity](clients/csharp/README.md) | Implements Protocol v1; cross-runtime parity is claimed only for behavior covered by shared fixtures or real HTTP tests. |
| [`@wardx/core`](packages/core/README.md) | In-process engine. Use `wardx` unless you write a custom runtime. |

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Verification

```bash
npm run verify
```

That merge gate runs JavaScript lint, representative public `.d.ts` consumer checks, the JavaScript suite and CLI black box, the C# suite and real C#→`wardx-server` interoperability, C# formatting/analyzers, both stress smoke profiles, and clean tarball installation with the packaged server binary.

```bash
npm run verify:release
```

The release gate adds both five-minute server profiles and the million-subject assignment check. It exits non-zero on any missed threshold.

## Agent skills

```bash
npx skills add https://github.com/clasen/Wardx --skill wardx-server
npx skills add https://github.com/clasen/Wardx --skill wardx
npx skills add https://github.com/clasen/Wardx --skill wardx-unity
npx skills add https://github.com/clasen/Wardx --skill wardx-csharp
```

## User retention

Use `wardx.retentionActivity(userId)` in Node or
`wardx.RetentionActivity(userId)` in C#/Unity on the activity that defines a
return. A stable explicit user ID and project privacy salt are required.
Wardx persists UTC first-activity cohorts and exact received-user D1/D7/D30
counts; MCP `get_retention` queries cohort dates and marks unfinished days as
pending. Delivery remains at-most-once, so lost activity can bias results.
See the [server retention contract](packages/server/README.md#persistent-user-retention)
for required configuration, limits and the SQLite schema upgrade.
