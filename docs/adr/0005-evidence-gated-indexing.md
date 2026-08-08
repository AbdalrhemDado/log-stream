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
- trigram index on the chosen case-folded message expression.

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

The reviewer approved the time/ID and service/time/ID baseline on `2026-08-08`. Level, GIN, and trigram indexes remain measurement-gated experiments and are not accepted as initial indexes.
