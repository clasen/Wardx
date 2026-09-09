---
name: wardx
description: Integrate or modify the Wardx Node.js SDK (wardx/createWardx) and @wardx/core. Use for Node telemetry, Remote Config, experiment assignment, and explicit user retention; use wardx-server for MCP or server operations.
---

# Wardx Node SDK

Use `wardx` for Node applications. Use `@wardx/core` only for a custom runtime:
the core has no HTTP transport. For SDK internals and verification, read
[references/package.md](references/package.md). Use the server skill for catalog
onboarding, experiment definitions, MCP queries, and server operations.

## Integrate

Create one instance per intended client lifecycle with `createWardx(options)`.
When enabled, required options are `endpoint`, `projectKey`, `project`, `role`, `appVersion`,
`environment`, and `privacySalt`. Read them from the application's configuration;
do not invent deployment values or derive the privacy salt from the key.

`project` must match the credential's server mapping. `role` is an open name
other than `*`; the server authorizes it against the credential's allowed roles.
Keep `privacySalt` stable and shared across clients in the same project.
Operational defaults and supported overrides live in `packages/core/defaults.json`.

```js
import { createWardx } from 'wardx';

const wardx = createWardx(telemetryConfig);
const requests = wardx.counter('http.requests', { route: 'matchmaking' });

function onRequest() {
  requests.inc();
}
```

Measurement calls are synchronous and update memory only. Bootstrap sync starts
immediately; later syncs use the configured interval and jitter. Delivery is
at-most-once: failed batches are discarded, with no disk queue or frame retries.
Use a different mechanism when loss is unacceptable.

## Reuse metric handles

Create metric handles once per client and stable name/dimension combination,
then reuse them in handlers, callbacks, and loops. This avoids repeated dimension
validation, series-key construction, and registry lookup. Normal aggregation
windows and flushes reset values, not handles. Rebind when replacing the client;
do not mutate a dimension dictionary to retarget an existing handle.

For varying dimensions, bind one recorder per application-owned, bounded value
set (mode, region, source). Never build an unbounded handle cache keyed by user
IDs or arbitrary input. Keep histogram buckets fixed. Timer tokens measure one
operation: create a fresh token for each operation, not one token for the client.
For a hot duration path, reuse a histogram and observe an application-measured
elapsed duration instead. Events, logs, retention, and experiment goals remain
per-occurrence calls.

`createWardx({ enabled: false })` returns an inert client with usable handles,
no engine/transport/timers, and immediate flush and shutdown. It needs no
connection options; config reads return the caller's fallback. This mode is fixed
at creation.

## Choose a signal

| Question | API |
| --- | --- |
| Count or amount | `counter(name, dims).inc()` / `.add(n)` |
| Latest value | `gauge(name, dims).set(value)` |
| Distribution | `histogram(name, { ...dims, buckets }).observe(value, attrs)` |
| Approximate unique count | `distinct(name, dims).add(identifier)` |
| Elapsed time | `const end = timer(name, dims)`; then `end(endDims)` |
| Discrete fact | `event(name, attrs)` |
| Diagnostic detail | `log.error(message, attrs)` or another log level |
| Explicit user activity for retention | `retentionActivity(userId)` |

Counters are window deltas; gauges are absent in windows without a `set`.
Reuse series handles in loops. Prefer counters for high-volume totals; add events
or logs when their bounded detail is useful, not automatically for every count.

Dimensions must be low-cardinality string/number/boolean values. Never put user
IDs, emails, or unique transaction IDs in metric dimensions. Invalid or over-cap
dimensions yield no-op series and increment `wardx.internal.cardinality_dropped`.
Histogram bounds are fixed per series; attrs retain only the window-max exemplar.
Use exemplars or bounded events/logs for diagnostic IDs, with appropriate redaction.

Distinct counts send salted fixed-size HLL sketches, not identifiers. A volume
funnel uses a separate signal name per step; event attrs do not split historical
counts. It cannot establish unique-user journeys or ordered sequences. SDK
`sessionId` is envelope identity, not an application session clock or join key.

For duration, use an application-owned monotonic clock and histogram bounds in
the chosen unit. If heartbeats add elapsed deltas to a total-time counter, add
only the unsent remainder at session end; do not add the full duration again.
The histogram may observe the full duration once. Choose the experiment goal
from the product question; session duration is only one possible goal.

## Remote Config and experiments

`config.get(key, fallback, context)` reads the last local snapshot without network
I/O. Before a snapshot arrives, missing keys use the caller's fallback. Remote
Config must contain no secrets; signal descriptions belong in the server catalog.

Role controls which keys and experiments this instance receives. Optional
server-side rules resolve the visible base values; an applicable A/B variant
overrides that base. Knobs are the adjustable config keys, not experiments.

Pass optional `attributes` to `createWardx`, or replace the whole map with
`wardx.setAttributes(attributes)`; `{}` clears it. Names are application-defined
and values are strings, finite numbers, or booleans. Attribute maps are copied
and shared by the instance, not selected per experiment subject. Do not switch
them between concurrent users. Keep role separate from OS/build/channel;
`platform` means the SDK runtime. Read the package reference for sync semantics.

On a single-user instance, `identify(userId)` sets the default experiment subject;
`identify(null)` clears it. On a multi-user backend, pass `{ subjectId }` per call
instead of changing the shared default. Identity is needed for assignment, not
for ordinary metrics or non-experiment Remote Config reads.

```js
const delayMs = wardx.config.get('message.delayMs', 1000, { subjectId: userId });
// At the actual matching outcome, after exposure:
wardx.experiment.goal('message.sent', { subjectId: userId, value: 1 });
```

Assignment is local and deterministic for the subject and experiment plan. A
matching config read can emit an exposure. Without a subject, the read returns
base Remote Config without exposure. `experiment.goal` throws without a subject
and emits only for a matching `goalMetric` with an exposure in this instance.
The SDK hashes the subject; do not add the raw ID to dimensions or attrs.
Do not define experiments or persist chosen variants in application code.
After `ship_experiment` reaches the client snapshot, the disabled experiment no
longer generates exposures; this is expected, not an identity failure.
Shipping updates the stored base and preserves conditional rules, which can
take precedence again after disablement.

## Retention

Call `retentionActivity(userId)` on the activity that defines a return. It needs
an explicit nonblank stable ID; `identify` does not supply it. Use the same activity
definition and stable project salt across devices. The server stores UTC cohorts
and received-user returns on D1/D7/D30. Lost batches can bias counts; delayed
activity can revise cohorts. Query semantics belong to the server skill.

## Lifecycle and diagnosis

Retain and await `shutdown()` in the application's existing shutdown integration.
It stops timers, flushes, and closes transport; repeated calls are safe. `flush()`
sends now without stopping timers. Do not replace the application's signal/exit
policy merely to integrate the SDK.

For local diagnosis, use `createConsoleTracer()` (stderr) or a tracer with the
needed hooks; never expose secrets through it. Tracing is not sent to the server.
For missing data, inspect failed/dropped frame counters, endpoint, credentials,
role, and capacity. For config fallbacks, check snapshot delivery and key visibility.
Event/log buffers drop new rows when full; prefer aggregated totals on hot paths.
When changing the SDK, preserve synchronous measurement and at-most-once delivery;
keep transport, timers, gzip, and process metrics out of the core.
