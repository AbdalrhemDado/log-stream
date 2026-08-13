# ADR 0002 — PostgreSQL Access and Safe Query Construction

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stages:** Stages 2, 4, 5, and 6 after explicit task authorization

## Context

PostgreSQL must remain the read/write source of truth. The service needs bulk inserts, dynamic combinations of filters, JSONB operations, concrete UTC time bucketing, cursor predicates, partitions, restricted runtime access, and inspectable execution plans. SQL injection is disqualifying.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| `pg` with explicit parameterized SQL and pure builders | Maximum SQL/plan control, transparent bulk work, low abstraction | More handwritten mapping and tests |
| Typed query builder | Compile-time assistance and composability | Dynamic JSONB/bucketing still needs raw fragments; generated SQL requires inspection |
| Full ORM | Productive for ordinary CRUD | Poor visibility/control for bulk arrays, partitions, JSONB, bucketing, and plans |

## Accepted decision

**ACCEPTED — 2026-08-08:** use `pg`, feature repositories, explicit transactions where multiple statements require atomicity, and small pure SQL builders returning `{ text, values }`. A standalone ingestion statement may rely on PostgreSQL's implicit transaction. Parameterize every user or cursor-derived value. Select bucket, group column, and other identifiers only through exhaustive hard-coded maps.

Attribute filters construct a safe one-key JSON object as a bound JSONB parameter. An empty ingestion attribute key remains valid and preserved, while bare `attr.` remains a separately invalid recognized query name because it has no `<key>` segment. Message substring patterns escape wildcard characters for literal semantics and remain bound values.

For aggregation, use PostgreSQL 16 as the compatibility baseline and `date_bin` with the fixed UTC epoch origin `TIMESTAMPTZ '1970-01-01 00:00:00+00'`. Map only `1m`, `5m`, `1h`, and `1d` to trusted interval expressions. Buckets are half-open `[start, start + bucket)`, the session timezone is UTC, and response timestamps serialize in UTC.

Ordinary repository traffic uses the restricted runtime role, never the PostgreSQL superuser or migration owner. Startup migrations use a separate owner connection as detailed in ADR 0008.

Pool acquisition/connection establishment and query execution use independent configuration values. Both default to a bounded 10 seconds. The pool value also limits how long `pg-pool` waits for an existing client, preventing the former two-second setting from converting transient queueing into premature HTTP 500 responses during bursts.

## Consequences

### Positive

- SQL text and parameter order can be unit tested exactly.
- `EXPLAIN ANALYZE` maps directly to code.
- No ORM object hydration or hidden query behavior.
- Bucket alignment is explicit and consistent across timestamp offsets.
- Repository SQL is evaluated under the same restricted privileges used by request traffic.

### Negative

- More explicit row/result conversion, including timestamps and bigint counts.
- Builders must correctly manage parameter numbering and shared predicates.
- The pinned PostgreSQL baseline and UTC session policy become runtime compatibility obligations.
- Restricted privileges require integration tests that do not accidentally run as the owner.

## Evidence and review gates

- Unit tests assert SQL text and values for every filter combination.
- Injection payloads remain parameters for service, level, time, attributes, `q`, limit, and cursor data.
- Integration tests use real PostgreSQL JSONB/time semantics.
- Aggregation tests cover each interval map, epoch alignment, events around boundaries, offset-equivalent instants, UTC serialization, empty ranges, and daylight-saving transitions.
- Repository tests assert the connected user is the runtime role and that unneeded DDL is denied.
- Query plans are captured for all primary patterns.

## References

- Requirements: `CORE-002`, `QRY-001`–`QRY-008`, `AGG-001`–`AGG-006`, `SEC-001`, `SEC-002`
- Edge cases: `EDGE-QRY-004`, `EDGE-QRY-009`, `EDGE-QRY-019`, `EDGE-ATTR-007`–`EDGE-ATTR-009`, `EDGE-AGG-004`, `EDGE-AGG-005`, `EDGE-AGG-009`
- Training: Learn SQL; Learn TypeScript; Learn HTTP Servers in TypeScript

## Acceptance record

The reviewer approved direct `pg` access, shared pure predicate builders, and PostgreSQL 16-compatible UTC `date_bin` bucketing with the fixed epoch origin and half-open intervals on `2026-08-08`. On `2026-08-13`, pool acquisition/connection and query timeouts were separated after the external benchmark showed failures clustered around the former shared two-second value. Both retained defaults are 10 seconds, but operators can tune them independently.
