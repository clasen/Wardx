# Wardx stress harness

The MVP is not done until these tests can run. They live in `@wardx/stress` and use only Node builtins plus workspace packages.

```bash
npm install
npm test
node packages/stress/src/index.js --smoke
node packages/stress/src/index.js --full
node packages/stress/src/index.js A
node packages/stress/src/index.js G --subjects 1000000
```

`--smoke` is the default (short durations, smaller fleets). Server test D runs both the raw upper-bound profile and the CLI-equivalent persistence profile unless `--profile raw` or `--profile persistence` selects one. The release gate runs both server profiles for five minutes and the million-subject assignment check.

## Tests

| ID | Name | What it measures |
| --- | --- | --- |
| A | Counter hot path | `inc()` ops/s, ns/op, RSS, event-loop delay |
| B | Mixed instrumentation | 70% counter / 15% histogram / 10% event / 5% log at 10k–250k ops/s |
| C | Flush spike | snapshot, `JSON.stringify`, gzip, event-loop delay |
| D | Server ingest profiles | Raw `NullSink` upper bound and CLI-equivalent persistence: throughput, latency, errors, event-loop delay, CPU/RSS; persistence adds retained state and disk writes |
| E | Fleet simulator | N jittered logical clients against `/v1/sync` |
| F | Remote Config storm | version bump under traffic; clients receive the new snapshot |
| G | Experiment consistency | 1M subjects: stability, independent FNV-1a, allocation, weights |

## Engineering targets (not benchmark results)

The values below are release targets. They are not claims that a particular Wardx version or deployment achieved them. A report must include the commit, command, Node version, hardware, duration, payload, client count, sink, `configPath` status, retention state, and observed errors/latencies.

Client:

- `counter.inc()` p99 < 2 µs
- `histogram.observe()` p99 < 5 µs
- `event()` / `log.info()` p99 < 10 µs
- 0 network/filesystem/Promise on the hot path

Runtime at 100k mixed ops/s:

- extra event-loop p99 delay < 5 ms
- no unbounded memory growth

Server target for test D's CLI-equivalent persistence profile with `NullSink`, `configPath`, coalesced sidecar writes, and growing retained state:

- 5,000 sync/s sustained
- HTTP error rate < 0.1%
- p99 < 100 ms

Full mode requests 5,250 sync/s by default and gates the measured result at 5,000 sync/s. The headroom prevents a timer paced at exactly the threshold from failing solely because of scheduler drift.

The 5,000 sync/s target's reference environment is one Wardx process on a dedicated machine or CI runner with at least 4 logical CPU cores, 8 GiB RAM, local SSD storage, local loopback HTTP, Node.js 20 or the current maintained Node release, and no competing workload. The raw profile has no `configPath` or sidecar writes and is only an upper bound. Neither profile includes production reverse-proxy or network overhead. Do not cite a target as an achieved result; publish measured numbers only with the exact profile, hardware, and full output.

Do not add a worker thread, change the 15s sync, or replace JSON+gzip until these numbers say so.

## Local ingest

```bash
npm run server
npm run example
```
