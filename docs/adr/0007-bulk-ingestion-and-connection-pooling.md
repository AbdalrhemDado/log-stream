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

**ACCEPTED — 2026-08-08:** use typed-array `UNNEST` as the initial bulk method. Internally compare chunk sizes such as 500, 1,000, and 5,000; these are not public batch limits. Multiple chunks for one accepted request execute in one transaction.

Use one shared `pg` pool with accepted starting maximum 4, then measure 2/4/8. Migrations acquire a client before traffic; retention shares the pool and skips work when its advisory lock is unavailable. Evaluate `COPY` only if durable `UNNEST` evidence misses the target or shows excessive CPU/memory.

## Consequences

### Positive

- Few round trips and explicit commit semantics.
- IDs/normalized values can be prepared before insertion.
- Small pool limits database context switching.

### Negative

- Large arrays/JSONB values consume app memory and encoding CPU.
- Shared pool can queue ingestion behind aggregation.
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

The reviewer approved `UNNEST` as the initial method and a shared pool baseline of four connections on `2026-08-08`. Chunk size, pool-size comparisons, and any `COPY` change remain measurement-gated.
