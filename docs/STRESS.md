# Wardx stress gates

```bash
npm run stress:smoke
npm run stress:full
```

Smoke is a short regression gate. Full mode runs for at least five minutes,
requests 5,250 sync/s, and requires at least 5,000 measured sync/s on the
complete single-process persistence profile.

Test D reports requested/actual throughput, HTTP and network errors, request
p50/p95/p99, event-loop p50/p99, CPU, RSS start/peak/growth, retained current
state, SQLite/WAL bytes, coalesced persistence writes/latency, pending batches/
bytes, SQLite transaction/busy failures, and checkpoints. Any threshold miss
exits non-zero. Test G independently verifies deterministic cross-runtime
assignment over the declared subject count.

The HTTP load generator runs in a dedicated worker. Wardx remains one server
instance on its own event loop, so client request-generation work is not counted
as server event-loop delay. The persistence profile also exercises trusted
experiment evidence, versioned control mutations, bounded historical queries,
forced checkpoints, deterministic overload rejection, and recovery.

Full thresholds:

| Measure | Gate |
| --- | ---: |
| Duration | at least 300 s |
| Actual sync rate | at least 5,000/s |
| HTTP error rate | at most 0.1% |
| Request p99 | at most 100 ms |
| Event-loop p99 | at most 50 ms |
| RSS growth | at most 512 MiB |
| Maximum coalesced persistence latency | at most 250 ms |
| SQLite transaction/busy failures | 0 |
| Pending batches/bytes after flush | 0 / 0 |

The comparable reference environment is one Wardx process, at least four
logical CPU cores and 8 GiB RAM, local SSD, loopback HTTP, Node 20 or the current
maintained Node release, and no competing workload. NFS, shared burstable CI,
containers below those limits, proxy/network traffic, and an active developer
machine are different proof boundaries.

These are release targets, not published benchmark results. A capacity claim
must include the exact commit, command, Node and SQLite versions, hardware and
SSD, operational config, project/signal/dimension/app-version/experiment
cardinality, payload sizes and rows, sync interval/client estimate, retention,
duration, and full unedited output. Never infer production capacity from unit
tests or a smoke run.
