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

`--smoke` is the default (short durations, smaller fleets). `--full` uses the SDD windows: 10M counter iterations, 5-minute mixed rates, and the published server/fleet targets.

## Tests

| ID | Name | What it measures |
| --- | --- | --- |
| A | Counter hot path | `inc()` ops/s, ns/op, RSS, event-loop delay |
| B | Mixed instrumentation | 70% counter / 15% histogram / 10% event / 5% log at 10k–250k ops/s |
| C | Flush spike | snapshot, `JSON.stringify`, gzip, event-loop delay |
| D | Server raw ingest | NullSink sync/s, p50/p95/p99, errors, CPU/RSS via process |
| E | Fleet simulator | N jittered logical clients against `/v1/sync` |
| F | Remote Config storm | version bump under traffic; clients receive the new snapshot |
| G | Experiment consistency | 1M subjects: stability, independent FNV-1a, allocation, weights |

## Engineering gates (SDD)

Client:

- `counter.inc()` p99 < 2 µs
- `histogram.observe()` p99 < 5 µs
- `event()` / `log.info()` p99 < 10 µs
- 0 network/filesystem/Promise on the hot path

Runtime at 100k mixed ops/s:

- extra event-loop p99 delay < 5 ms
- no unbounded memory growth

Server, NullSink, representative payloads:

- 5,000 sync/s sustained
- HTTP error rate < 0.1%
- p99 < 100 ms

Do not add a worker thread, change the 15s sync, or replace JSON+gzip until these numbers say so.

## Local ingest

```bash
npm run server
npm run example
```
