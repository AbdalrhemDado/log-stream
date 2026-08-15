# ADR 0005 — Evidence-Gated Indexing

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation and validation stages:** Stages 2, 6, and 9 after explicit task authorization

## Context

Filters are freely combinable, while ingestion must sustain at least 15,000 logs/sec on one PostgreSQL CPU. Every index can improve a read pattern and simultaneously increase write CPU, WAL, storage, and commit latency.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Create all plausible indexes initially | Broad initial read acceleration | Maximum write amplification with no evidence |
| Minimal baseline plus controlled index experiments | Protects writes and yields clear before/after evidence | Some secondary filters initially scan |
| One wide composite index | Simple inventory | Only helps queries matching its leading-column order |

## Accepted decision

**ACCEPTED — 2026-08-08:** initial indexes are:

1. the partition-compatible primary/unique `(timestamp, id)` B-tree, scanned backward for descending range order and keyset pagination, without a duplicate standalone index;
2. `(service, timestamp DESC, id DESC)` for a likely primary exact dimension.

Treat these as experiments requiring plan evidence:

- `(level, timestamp DESC, id DESC)` because level selectivity is low;
- GIN `jsonb_path_ops` on `attributes_search`;
- trigram index on the message column.

Add one material index at a time and retain it only when query/aggregation improvement justifies ingestion, WAL, memory, and size cost.

## Consequences

### Positive

- The write path starts with limited amplification.
- Each index has a defensible query pattern and measured effect.
- Failed experiments can be removed without rewriting the architecture narrative.

### Negative

- Attribute, level, or substring queries may initially be slow.
- Performance work is required before submission; the schema is not “done” after its first migration.

## Evidence and review gates

- `EXPLAIN ANALYZE` for recent, service, level, attribute, message, and primary aggregation queries.
- Record index sizes and scan types.
- Compare durable ingestion, WAL, and query p95 before/after each candidate.
- Verify partitioned index creation/maintenance if ADR 0006 is accepted.

## References

- Requirements: `QRY-001`–`QRY-010`, `AGG-004`, `PERF-001`–`PERF-004`
- Edge cases: `EDGE-QRY-005`, `EDGE-QRY-009`, `EDGE-ATTR-012`
- Training: Learn SQL; Build a Blog Aggregator in TypeScript; Learn Docker

## Acceptance record

The reviewer approved the time/ID and service/time/ID baseline on `2026-08-08`.

On `2026-08-14`, the reviewer authorized the performance work and the message-search experiment retained a partitioned `pg_trgm` GiST index using `gist_trgm_ops(siglen = 64)`. On the controlled one-million-row dataset, the literal mixed-case substring plan changed from parallel sequential scans at 107.494 ms to bitmap GiST scans at 7.860 ms. The GiST family occupied 120,012,800 bytes across parent and leaf catalog entries. A constrained 100,000-row HTTP run then accepted and reconciled every row at 15,017.470 logs/s with 203.859 ms ingestion p95 and 135.681 ms aggregation p95.

The JSONB GIN experiment was rejected. Its small-pending-list variant did not improve the cold attribute plan materially (26.255 ms versus the 26.548 ms baseline), and combining JSONB and message indexes terminated PostgreSQL inside the required 1 GiB limit during the one-million-row review. The level index remains rejected because the existing ordered time scan served the measured level page in under one millisecond. These are controlled observations, not a guarantee of external benchmark results.
