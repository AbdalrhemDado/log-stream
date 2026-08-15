# ADR 0007 — Bulk Ingestion and Connection Pooling

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation and validation stages:** Stages 4 and 9 after explicit task authorization

## Context

Accepted rows must be committed before success while reaching at least 15,000 logs/sec. The app has 0.5 CPU, PostgreSQL has one CPU, batches may be large, and one aggregation request/sec runs concurrently.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Multi-row `VALUES` | Familiar | Large SQL text and placeholder count |
| Typed arrays with `UNNEST` | Stable SQL text, set-based, transaction-friendly | Parallel-array/cast and client-encoding complexity |
| `COPY` stream | Highest potential raw throughput | Complex stream errors, JSON encoding, and transaction handling |
| Per-row insert | Simple | Round-trip/statement overhead makes target implausible |

Pool alternatives are one small shared pool, separate workload pools, and PgBouncer. Separate pools/proxies add knobs and can oversubscribe one database CPU.

## Accepted decision

**ACCEPTED — 2026-08-08; UPDATED — 2026-08-14:** use typed-array `UNNEST` as the bulk method. The current repository executes exactly one insert statement for each database write, so PostgreSQL's implicit transaction provides the required atomic commit. Under overload, a bounded coordinator combines complete concurrent public requests into one database write. Every participating request resolves only after that shared statement commits; none of the public requests are split. PostgreSQL derives string-normalized search attributes from the already-parsed original JSONB inside that statement, avoiding a second application object and parameter array. If a future implementation splits one public request across multiple statements, all statements must again use one explicit transaction. Internal batching limits are never public batch limits.

Use one shared `pg` pool with maximum 4. The adaptive write coordinator starts up to three writes immediately and reserves the fourth pool lane for queries. Additional concurrent requests are coalesced for up to 2 ms or 1,000 rows, with a bounded 50,000-row waiting queue. Migrations acquire a client before traffic; retention shares the pool and skips work when its advisory lock is unavailable. Evaluate `COPY` only if durable `UNNEST` evidence misses the target or shows excessive CPU/memory.

## Consequences

### Positive

- One database round trip and PostgreSQL commit semantics.
- Fewer commits and statements when small public requests create a backlog.
- Low-concurrency writes start immediately instead of paying the batching delay.
- PostgreSQL absorbs normalization work after batching frees database CPU capacity.
- Small pool limits database context switching.

### Negative

- Large arrays/JSONB values consume app memory and encoding CPU.
- SQL-side normalization increases PostgreSQL work per stored row.
- Coalesced requests share one failure boundary and all fail if their common statement fails.
- The coordinator reduces but does not eliminate shared-pool contention.
- `COPY` may still be required after measurement.

## Evidence and review gates

- Validator/normalizer/repository microbenchmarks.
- Durable throughput, commit latency, pool waiting, RSS/heap, CPU, WAL, and row reconciliation.
- Controlled chunk and pool-size matrix.
- Controlled `UNNEST` versus `COPY` only when justified.

## References

- Requirements: `ING-009`, `ING-013`, `PERF-001`, `PERF-003`, `PERF-005`, `REL-001`
- Edge cases: `EDGE-BAT-007`–`EDGE-BAT-011`, `EDGE-QRY-020`
- Training: Learn SQL; Learn TypeScript; Learn HTTP Clients in TypeScript

## Acceptance record

The reviewer approved `UNNEST` as the initial method and a shared pool baseline of four connections on `2026-08-08`. On `2026-08-13`, an identical 25-row repository microbenchmark improved from 8,747.755 to 20,280.208 rows/s after redundant explicit `BEGIN`/`COMMIT` round trips were removed. A one-pass preallocated parameter builder then measured 21,570.673 rows/s. Every run reconciled all 2,500 measured rows. Cross-request write coalescing was tested and rejected because it reduced constrained HTTP throughput. Any future chunking, pool-size, or `COPY` change remains measurement-gated.

On `2026-08-14`, the external grader showed that the earlier low-concurrency coalescing experiment did not represent its open-loop backlog. An adaptive coordinator was therefore tested against an identical 100,000-row, 25-row/request, concurrency-64 workload. It improved confirmed throughput from 8,291.276 to 12,178.509 logs/s, reduced ingestion p95 from 301.984 to 222.798 ms, and reduced aggregation p95 from 455.486 to 172.198 ms. Both runs returned 4,000 HTTP 200 responses and reconciled all 101,000 warm-up plus measured rows. Always-on batching was rejected because it reduced the low-concurrency 50-row workload; the retained coordinator starts available lanes immediately and batches only queued overload.

The same day, SQL-side search normalization improved that retained concurrency-64 case from 12,178.509 to 12,917.729 logs/s and aggregation p95 from 172.198 to 154.307 ms. It also improved the 50-row/concurrency-4 case from 13,752.857 to 14,693.424 logs/s. PostgreSQL peak CPU rose from 29.12% to 39.67% in the high-concurrency comparison and from 49.81% to 78.07% in the low-concurrency comparison, remaining within its enforced one-CPU allocation. Four immediate writer lanes did not improve throughput and raised aggregation p95 to 238.388 ms, so the three-lane query reservation remains retained.
