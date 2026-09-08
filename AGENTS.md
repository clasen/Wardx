# Wardx repository guide

## Project

Wardx is a self-hosted telemetry, Remote Config, and experimentation system.
This monorepo contains the Node SDK, core engine, server, stress tools, and the
C# / Unity clients.

## Runtime and package manager

- Use Node.js 20 or newer.
- Use npm workspaces and the committed `package-lock.json`.
- The JavaScript packages use native ESM.
- Do not add, remove, or upgrade dependencies without asking first.

## Verification

Always ask the user before running either full verification command:

```bash
npm run verify
npm run verify:release
```

This requirement applies even when verification would normally be mandatory
before declaring a code change complete. If permission is not granted, run only
the narrow checks relevant to the change and report that full verification was
not run.

Focused checks such as the following do not require prior confirmation:

```bash
npm run lint
npm run typecheck
npm run test:js
npm run test:black-box
npm run test:csharp
npm run check:csharp
npm run stress:smoke
npm run pack:check
```

Do not run `npm run stress:full` unless the user explicitly requests a full
stress run or authorizes `npm run verify:release`.

## Repository layout

- `packages/core`: in-process telemetry engine.
- `packages/node`: Node.js SDK published as `wardx`.
- `packages/server`: ingest and MCP server published as `@wardx/server`.
- `packages/stress`: smoke, release stress, and packaging checks.
- `clients/csharp`: C# and Unity clients.
- `config`: development and production server configuration.
- `skills`: agent integration skills shipped with the repository.

## Operational safety

- Do not start, restart, deploy, or exercise a production Wardx server without
  explicit authorization.
- Never print or commit credentials, bearer tokens, project keys, or production
  configuration secrets.
- Treat Remote Config and catalog mutations as production changes when pointed
  at a live server; ask before executing them.

## Git and releases

- Preserve unrelated working-tree changes.
- Do not commit, push, tag, or publish unless explicitly requested.
- A requested release includes the version bump, authorized verification,
  commit, push, publication, and independent remote and registry verification.
- Report deterministic local checks separately from deployed production proof.
