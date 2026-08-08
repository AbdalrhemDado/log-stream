# ADR 0006 — Partitioning and Retention

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Stages 2 and 7 after explicit task authorization

## Context

The service stores roughly one month of event-time data and needs configurable retention without long locks, excessive bloat, or major ingestion disruption. Valid timestamps have no lower age bound.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Unpartitioned table plus bounded deletes | Simple schema and global indexes | Dead tuples, WAL, vacuum, and ongoing cleanup contention |
| Daily timestamp partitions | Fine retention drops and time pruning | DDL/default partition/planning/constraint complexity |
| Monthly partitions | Fewer children | Coarse expiry and partial-partition deletes |

Retention scheduling alternatives are an in-app worker with advisory locking, a PostgreSQL scheduler extension, and a separate worker container. The latter two add deployment requirements.

## Accepted decision

**ACCEPTED — 2026-08-08:** partition by event timestamp per UTC day. Pre-create the retention window and at least two future days; keep a default partition for valid out-of-window rows. Required partitions exist before readiness. Before attaching a missing daily partition, preparation must detect and safely handle any overlapping rows already routed to the default partition.

Use an in-process retention coordinator with a non-blocking PostgreSQL advisory lock. Drop fully expired partitions individually and delete expired default-partition rows in bounded committed batches. Define expired as `timestamp < cutoff`.

Accept otherwise valid old logs; they are immediately eligible for retention rather than being rejected by an undocumented ingestion rule.

## Consequences

### Positive

- Whole expired days can be removed without mass row deletes.
- Bounded partition count and possible time pruning.
- No additional runtime service.

### Negative

- Partition-aware keys/indexes/migrations are more complex.
- Default partition can accumulate data when maintenance fails.
- Recovery can require moving overlapping default rows before PostgreSQL permits a new partition attachment.
- Planning/routing overhead may not be justified at one million rows.

## Evidence and review gates

- Fresh and repeated startup partition-preparation tests.
- Boundary, old-log, default-partition overlap/recovery, advisory-lock, failure, and shutdown tests.
- Concurrent cleanup/ingestion/aggregation measurement.
- Compare against unpartitioned bounded deletion if planning or ingestion cost is material.

## References

- Requirements: `HLT-001`, `RET-001`–`RET-003`, `REL-001`, `PERF-003`, `PERF-004`
- Edge cases: `EDGE-VAL-012`, `EDGE-RET-001`–`EDGE-RET-006`
- Project decision: `DEC-015`
- Training: Learn SQL; Build a Blog Aggregator in TypeScript; Learn TypeScript; Learn Docker

## Acceptance record

The reviewer approved daily UTC partitions with a default partition, overlap recovery, advisory-locked retention, old-log acceptance, and `< cutoff` expiry semantics on `2026-08-08`.
