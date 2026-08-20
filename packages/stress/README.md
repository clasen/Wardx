# @wardx/stress

`@wardx/stress` is the Wardx stress harness.

The harness measures the client hot path, mixed instrumentation, flush cost, ingest throughput, fleet load, Remote Config updates, and experiment assignment.

This package is not published to npm. Run the harness from the source repository.

Node.js 20 or later is required.

## Install

From the repository root:

```bash
npm install
```

The workspace links `@wardx/core`, `wardx`, and `@wardx/server`.

## Run

Default is smoke mode. Smoke mode uses short durations and smaller fleets.

```bash
npm install
npm test
node packages/stress/src/index.js --smoke
node packages/stress/src/index.js --full
node packages/stress/src/index.js A
node packages/stress/src/index.js G --subjects 1000000
```

`--smoke` is the default when you do not pass `--full`. `--full` uses the SDD windows: 10 million counter iterations, 5-minute mixed rates, and the published server and fleet targets.

CLI flags:

| Flag | Description |
| --- | --- |
| `--smoke` | Short durations. Smaller fleets. |
| `--full` | SDD windows. |
| `--rate <n>` | Operations per second or syncs per second. Smoke default is `1000`. |
| `--duration <ms>` | Duration in milliseconds. Smoke default is `2000`. Full default is `300000`. |
| `--clients <n>` | Logical clients for test E. Smoke default is `200`. Full default is `10000`. |
| `--subjects <n>` | Subjects for test G. Smoke default is `50000`. Full default is `1000000`. |

The first positional argument is the test id: `A` to `G`, or `all`. The default is `all`.

## Use case 1: Verify the client hot path

**When:** You change metric code in `@wardx/core`.

**Objective:** Measure `counter.inc()` cost.

```bash
node packages/stress/src/index.js A
```

The harness reports operations per second, nanoseconds per operation, RSS, and event-loop delay.

Gate: `counter.inc()` p99 less than 2 µs.

## Use case 2: Measure mixed instrumentation

**When:** You need the cost of counters, histograms, events, and logs together.

**Objective:** Run a mixed rate and watch event-loop delay.

```bash
node packages/stress/src/index.js B --smoke --rate 1000 --duration 2000
```

The mix is 70% counter, 15% histogram, 10% event, and 5% log.

Gate at 100k mixed operations per second: extra event-loop p99 delay less than 5 ms. No unbounded memory growth.

## Use case 3: Measure a flush spike

**When:** You change snapshot, JSON, or gzip code.

**Objective:** Measure snapshot, `JSON.stringify`, gzip, and event-loop delay.

```bash
node packages/stress/src/index.js C
```

## Use case 4: Measure ingest throughput

**When:** You change the ingest server.

**Objective:** Send sync requests to a server with `NullSink`.

```bash
node packages/stress/src/index.js D --smoke --rate 1000 --duration 2000
```

The harness reports syncs per second, p50, p95, p99, errors, CPU, and RSS.

Gate with `NullSink` and representative payloads: 5000 syncs per second sustained. HTTP error rate less than 0.1%. p99 less than 100 ms.

## Use case 5: Simulate a client fleet

**When:** You need many jittered logical clients against `/v1/sync`.

**Objective:** Run test E.

```bash
node packages/stress/src/index.js E --clients 200 --duration 2000
```

Smoke uses a short sync interval. Full uses 15 seconds.

## Use case 6: Bump Remote Config under traffic

**When:** You change config distribution.

**Objective:** Confirm that clients receive the new snapshot.

```bash
node packages/stress/src/index.js F --smoke
```

The harness bumps the config version during the run. Clients that send the old version must get the new snapshot.

## Use case 7: Check experiment assignment

**When:** You change FNV-1a or variant weights.

**Objective:** Assign 1 million subjects. Confirm stability, independence, allocation, and weights.

```bash
node packages/stress/src/index.js G --subjects 1000000
```

The harness compares `assignVariant` with an independent FNV-1a implementation.

## Engineering gates

Client:

- `counter.inc()` p99 less than 2 µs
- `histogram.observe()` p99 less than 5 µs
- `event()` / `log.info()` p99 less than 10 µs
- 0 network, filesystem, or Promise on the hot path

Runtime at 100k mixed operations per second:

- extra event-loop p99 delay less than 5 ms
- no unbounded memory growth

Server, `NullSink`, representative payloads:

- 5000 syncs per second sustained
- HTTP error rate less than 0.1%
- p99 less than 100 ms

Do not add a worker thread, change the 15 s sync, or replace JSON and gzip until these numbers say so.

## Related packages

These packages are for npm:

- Node.js SDK: `wardx`
- Engine: `@wardx/core`
- Ingest server: `@wardx/server`
