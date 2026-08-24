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

`--smoke` is the default when you do not pass `--full`. Server test D runs both the raw upper-bound profile and the CLI-equivalent persistence profile unless `--profile` selects one. The release gate runs both server profiles for five minutes and then runs the million-subject assignment check.

CLI flags:

| Flag | Description |
| --- | --- |
| `--smoke` | Short durations. Smaller fleets. |
| `--full` | SDD windows. |
| `--rate <n>` | Operations per second or syncs per second. Smoke default is `1000`; full default is `5250` so the 5000/s gate measures capacity instead of timer-perfect pacing. |
| `--duration <ms>` | Duration in milliseconds. Smoke default is `2000`. Full default is `300000`. |
| `--clients <n>` | Logical clients for test E. Smoke default is `200`. Full default is `10000`. |
| `--subjects <n>` | Subjects for test G. Smoke default is `50000`. Full default is `1000000`. |
| `--profile <raw\|persistence>` | Run only one server profile in test D. Both run when omitted. |

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

**Objective:** Measure the raw ingest upper bound separately from the production persistence path.

```bash
node packages/stress/src/index.js D --smoke --rate 1000 --duration 2000
node packages/stress/src/index.js D --full --profile persistence
```

The `raw` profile uses `NullSink` without `configPath` and is labeled only as an upper bound. The `persistence` profile writes a real config, reloads it through `loadServerConfig` as the CLI does, retains four minute windows, grows metric series during the run, and flushes the coalesced persistence coordinator before evaluation.

Both profiles report syncs per second, HTTP/network errors, CPU, start/peak/growth RSS, event-loop p50/p99, and request p50/p95/p99. The persistence profile additionally reports retained windows and series, sidecar size, disk write count and failures, and total/maximum write latency from the production persistence coordinator.

The published 5,000 sync/s target belongs to the `persistence` profile, not the raw upper bound. Its reference environment is one Wardx process on a dedicated machine or CI runner with at least 4 logical CPU cores, 8 GiB RAM, local SSD storage, local loopback HTTP, Node.js 20 or the current maintained Node release, and no competing workload. Results from network filesystems, shared burstable runners, containers with lower CPU/memory limits, or active developer machines are not comparable performance evidence.

Gate thresholds are explicit:

| Gate | Minimum throughput | Error rate | Request p99 | Event-loop p99 | RSS growth | Maximum disk write latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Smoke | 50% of requested rate | 0 | 1000 ms | 500 ms | 256 MiB | 1000 ms |
| Full | 5000 sync/s for at least 5 minutes (5250/s requested by default) | 0.1% | 100 ms | 50 ms | 512 MiB | 250 ms |

The persistence profile also requires at least four retained windows and series, at least one successful write, no write failure, a clean coordinator after flush, and no more than `3 * (ceil(duration / persistenceFlushIntervalMs) + 1)` writes. The factor of three is the fixed set of aggregate-window, experiment-stat, and retained-log sidecars that one coalesced flush may write. Any missed threshold throws and makes the process exit non-zero.

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

## Engineering targets (not benchmark results)

These values are release targets, not evidence that a version or deployment achieved them. When publishing a result, include the commit, command, Node version, hardware, duration, payload, client count, sink, whether `configPath` enabled persistence, retention-state size, and all observed errors and latencies.

Client:

- `counter.inc()` p99 less than 2 µs
- `histogram.observe()` p99 less than 5 µs
- `event()` / `log.info()` p99 less than 10 µs
- 0 network, filesystem, or Promise on the hot path

Runtime at 100k mixed operations per second:

- extra event-loop p99 delay less than 5 ms
- no unbounded memory growth

Server target for test D's CLI-equivalent persistence profile with `NullSink` and growing retained state:

- 5000 syncs per second sustained
- HTTP error rate less than 0.1%
- p99 less than 100 ms

Test D's raw profile excludes sidecar persistence and disk latency. It remains useful as a ceiling but cannot support a production throughput claim.

Do not add a worker thread, change the 15 s sync, or replace JSON and gzip until these numbers say so.

## Related packages

These packages are for npm:

- Node.js SDK: `wardx`
- Engine: `@wardx/core`
- Ingest server: `@wardx/server`
