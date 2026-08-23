# Wardx

To find out what your own product is doing, you set up five services: analytics in one, remote config in another, experiments in a third, logs wherever they land. Then you paste IDs by hand between dashboards that don't talk to each other. One server is enough for that, and Wardx is that server. Your Unity app and your Node backend send it events, metrics and errors as they happen, and get back the configuration meant for them: the game sees its variables, the server sees its own. You run it on your VPS, and all your projects live inside it, kept apart from each other.

Hand what that server collects to an agent and it sees the product the way you do: yesterday's numbers, the last hour of errors, the config running right now. Ask it why onboarding drops off at step three and it answers with your data in front of it. Show it the account claiming rewards every four seconds and it tells you whether that's a bug of yours or someone testing the edge.

The same channel that carries the data up carries the configuration back down, so the agent doesn't stop at the diagnosis: it changes a variable, turns it into a hypothesis, lets it run as an A/B test, and comes back three days later to look at the numbers. Optimization stays within reach. You open the chat on a Tuesday afternoon, see what moved in the funnel, and decide whether the change stays. If it didn't work, you put the variable back and try another.

```text
                         AGENT
                  arisa.sh / Codex / Claude
                             │
                    MCP stdio
                    tools + wardx://project/{name}
                             ▼
┌───────────────────────────────────────────────────┐
│              wardx-server (one process)           │
│              N isolated projects                  │
│                                                   │
│   MCP ──► ControlService                          │
│              ├── Remote Config snapshot            │
│              ├── Experiment definitions            │
│              ├── Aggregates                       │
│              ├── Recent logs                      │
│              └── Catalog                          │
│                                                   │
│   HTTP POST /v1/sync                              │
│        ├── envelope store (config.sink)            │
│        │     null | memory | ndjson               │
│        └── per-project ingest                     │
│              aggregator, recent logs, clients     │
│              config reply filtered by client.role   │
└─────────────────────────▲─────────────────────────┘
                          │
             frames up / that role's config down
          ┌───────────────┴───────────────┐
          ▼                               ▼
   Node SDK                          C# / Unity SDK
   wardx / @wardx/core               clients/csharp
   role: game-server                 role: mobile
   metrics / config.get               same /v1/sync
```

HTTP is the client path. Control, analysis, and visualization use MCP on the same process. There is no admin HTTP API.

## Packages

| Package | Role |
| --- | --- |
| [`@wardx/server`](packages/server/README.md) | That server. Ingest, Remote Config, experiments, MCP. |
| [`wardx`](packages/node/README.md) | Node.js SDK. |
| [C# / Unity](clients/csharp/README.md) | Same wire contract as the Node SDK. |
| [`@wardx/core`](packages/core/README.md) | In-process engine. Use `wardx` unless you write a custom runtime. |

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Agent skills

```bash
npx skills add https://github.com/clasen/Wardx --skill wardx-server
npx skills add https://github.com/clasen/Wardx --skill wardx
npx skills add https://github.com/clasen/Wardx --skill wardx-unity
npx skills add https://github.com/clasen/Wardx --skill wardx-csharp
```
