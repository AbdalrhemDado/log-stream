# ADR 0011 — Testing and Performance Validation

- **Status:** `PROPOSED — NOT APPROVED`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Continuous, with performance gates in Stages 8–9

## Context

The project must provide meaningful CI and evidence for throughput, latency, freshness, concurrency, data integrity, and resource limits. Unit-only tests cannot validate PostgreSQL behavior, while ad hoc benchmarks cannot support credible performance claims.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Unit tests with mocked persistence | Fast and easy to isolate | Cannot validate SQL, transactions, indexes, migrations, or PostgreSQL typing |
| Real PostgreSQL integration plus black-box Compose tests | High contract and database confidence | Slower and requires deterministic lifecycle management |
| One end-to-end suite for everything | Tests the assembled system | Slow diagnosis and poor coverage of boundary combinations |

## Proposed decision

**PROPOSED — not approved:** use a layered test architecture:

1. pure unit and table-driven tests for validation, parsing, cursor codecs, error mapping, and safe query-plan construction;
2. repository/integration tests against real PostgreSQL for migrations, SQL semantics, transactions, retention, indexes, and concurrency;
3. black-box tests against the Compose stack for exact HTTP contracts, readiness, restart, and zero-configuration behavior;
4. a reproducible external load harness for ingestion plus one aggregation request per second under the required resource limits.

Use the project's TypeScript test runner for unit/integration orchestration, but treat tool selection as implementation-stage confirmation. Do not mock PostgreSQL for claims about persistence. Isolate tests through disposable databases or schemas and deterministic cleanup.

The benchmark records hardware/software environment, dataset generator and distribution, row count, batch size, client concurrency, duration, accepted/rejected/reconciled rows, ingestion throughput, latency percentiles, freshness, CPU/memory, PostgreSQL statistics, query plans, bottlenecks, and each before/after optimization. Warm-up and measurement intervals are separate. Performance acceptance requires concurrent ingestion and aggregation, not separate best-case runs.

## Consequences

### Positive

- Fast tests catch logic errors while real-database layers catch semantic failures.
- Reproducible evidence supports the interview and avoids invented claims.
- Row reconciliation protects against high-throughput data loss hidden by request rates.

### Negative

- More test layers increase CI time and lifecycle complexity.
- Local hardware variation means results need precise environment context.
- Database and operating-system telemetry require careful interpretation.

## Evidence and review gates

- CI build, lint/type-check, unit, integration, and Docker contract jobs.
- A stable correctness seed at boundary cases plus a representative million-row performance dataset.
- Repeated load runs with raw machine-readable output retained alongside a summarized report.
- `EXPLAIN (ANALYZE, BUFFERS)` only in controlled measurement, with plans captured for the primary aggregation and critical queries.
- Required acceptance evidence: at least 15,000 accepted logs/second, aggregation below one second p95 at one request/second during ingestion, data visible within 20 seconds, resource-limit compliance, and exact row reconciliation.

## References

- Requirements: `CI-001`, `PERF-001`–`PERF-007`, `DEL-003`, `DEL-004`
- Edge cases: all settled contract boundaries; especially `EDGE-BAT-008`, `EDGE-BAT-010`, `EDGE-QRY-020`, `EDGE-CUR-006`, `EDGE-RET-003`, `EDGE-RET-005`
- Training: Learn TypeScript; Learn HTTP Clients in TypeScript; Build a Pokedex in TypeScript; Learn SQL; Build a Blog Aggregator in TypeScript; Learn HTTP Servers in TypeScript; Learn Docker

## Approval questions

1. Approve the four-layer testing architecture and real-PostgreSQL integration requirement?
2. Approve row reconciliation and concurrent ingestion/aggregation as non-negotiable benchmark validity checks?
3. Approve retaining raw benchmark artifacts and explicitly documenting the execution environment?
