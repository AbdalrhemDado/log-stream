# LogStream Interview Questions and Model Answers

Use the model answers as compact speaking notes, not scripts to memorize. A strong answer states the behavior, explains why it exists, names a tradeoff, and points to evidence.

## Architecture and TypeScript

### 1. Why separate routes, services, and repositories?

Routes translate HTTP; services enforce use-case behavior; repositories own SQL and transaction boundaries. The separation keeps validation testable without PostgreSQL, keeps SQL out of transport code, and makes dependencies explicit. The cost is more interfaces and files, which is worthwhile here because ingestion, querying, retention, and failure handling each need focused tests.

### 2. What TypeScript techniques make untrusted input safer?

The project treats request values as `unknown`, narrows them with explicit runtime checks, and returns discriminated success/failure unions. Canonical timestamps and log IDs use branded string types so arbitrary strings cannot silently cross validated boundaries. `readonly` interfaces document non-mutation, while dependency interfaces make clocks, UUID generation, pools, and timers testable.

### 3. Does a TypeScript type validate JSON at runtime?

No. Types disappear after compilation. A client can send any JSON shape, so validators must check objects, arrays, own data properties, strings, finite numbers, enum membership, timestamps, and PostgreSQL-incompatible U+0000 before a value receives a trusted type.

### 4. Why copy attribute objects into null-prototype objects?

Keys such as `__proto__` and `constructor` are valid user data but have special meaning on ordinary JavaScript objects. Null-prototype copies plus own-property inspection prevent prototype mutation or inherited-property confusion while preserving arbitrary keys.

## HTTP and ingestion

### 5. Why can one ingestion request return both accepted and rejected items?

The contract validates entries independently. The service retains original indexes for invalid entries, inserts all valid entries together, and reports both counts. Mixed success is HTTP 200 because durable work occurred; an all-invalid batch is HTTP 400 and performs no repository call.

### 6. When is an accepted log durable?

Only after the one typed-array `UNNEST` insert completes. PostgreSQL runs a standalone statement in an implicit transaction, and `pg` resolves the query only after that transaction commits. Client dispatch or a generated UUID is not counted as acceptance.

### 7. Why use `UNNEST` instead of one INSERT per row?

It reduces network round trips, SQL parsing, and transaction overhead while retaining parameterization. Alternatives include multi-value INSERT and `COPY`. `COPY` may be faster but complicates partial-batch orchestration, typing, transaction/error semantics, and the trainee-facing implementation; the retained path met the target under exact limits.

### 8. What happens if the connection fails while the insert is committing?

The client may not know whether PostgreSQL committed the implicit transaction. The service returns a safe availability error rather than retrying inside the repository and risking duplicates; the load generator classifies unresolved/indeterminate accounting separately.

### 9. Why reject timestamps more than five minutes in the future but accept old logs?

That is the required contract. The future bound catches likely clock or input errors. Old event times remain valid for backfill, but retention is event-time based, so very late logs can become eligible on the next maintenance cycle.

## Querying, JSONB, and cursors

### 10. How is SQL injection prevented?

Every user-controlled value is a PostgreSQL parameter. Dynamic SQL is limited to code-owned allowlists for bucket intervals and grouping expressions, or trusted migration identifiers. Literal substring search escapes `\`, `%`, and `_`; arbitrary attribute keys are JSON-serialized into a parameter rather than interpolated into SQL.

### 11. Why store two JSONB attribute documents?

`attributes` preserves original API types. `attributes_search` maps each value to a deterministic string so `attr.key=value` has one stable equality rule across strings, numbers, and booleans. The tradeoff is duplicate storage and normalization work; the benefit is simple exact containment without losing response fidelity.

### 12. How are numbers normalized for attribute search?

Finite numbers use JSON number serialization; negative zero becomes `0`. Booleans become lowercase `true` or `false`, and strings stay unchanged. The original JSONB still preserves the accepted value type.

### 13. Why keyset pagination instead of OFFSET?

OFFSET makes PostgreSQL visit and discard an increasing prefix and is unstable under concurrent writes. Keyset pagination applies `(timestamp,id) < last_tuple` against the deterministic descending order. It has predictable page work, though separate requests still do not share a snapshot.

### 14. What is inside the cursor, and is it secure?

It is canonical base64url JSON containing a version, last timestamp, UUID, and SHA-256 fingerprint of canonical filters. Strict decoding catches malformed/noncanonical values and the fingerprint catches filter changes. It is unsigned, so it is neither an authorization token nor an integrity boundary; database predicates and any gateway authorization must remain authoritative.

### 15. Why are `since` inclusive and `until` exclusive?

Half-open intervals compose cleanly without overlap: adjacent ranges `[a,b)` and `[b,c)` cover each row once. They also align naturally with range partitions and fixed time buckets.

## PostgreSQL, indexes, aggregation, and retention

### 16. Why is the primary key `(timestamp, id)`?

PostgreSQL requires a partitioned-table unique constraint to include the partition key. Timestamp supports event-time partitioning and descending pages; UUID v4 breaks ties without a centralized sequence. The pair yields stable total ordering, at the cost of a wider key and random UUID storage.

### 17. Why keep only one secondary index?

The primary-key index supports chronological keyset pages. `(service,timestamp DESC,id DESC)` supports a common service-scoped page. Every extra index adds write amplification and storage, so no GIN or text-search index was retained without query-plan and latency evidence.

### 18. Why can a sequential scan be correct for aggregation?

An index is not automatically faster. A 24-hour aggregation processes a substantial fraction of two pruned daily partitions, so sequential reads plus aggregation can be cheaper than many index lookups. The confirmation post-run plan executed in 21.916 ms with no temp I/O, and concurrent public HTTP p95 was 194.790 ms—well below one second.

### 19. How does aggregation avoid SQL injection in bucket and group fields?

The parser accepts only `1m`, `5m`, `1h`, `1d` and optional `service` or `level`. Repository maps are exhaustive TypeScript records from those literal unions to fixed SQL fragments. Values and ordinary filters remain parameters.

### 20. Why use daily range partitions plus a default partition?

Daily partitions make event-time pruning and retention-by-drop practical. The default partition preserves ingestion when a timestamp falls outside prepared days. Before attaching a new day, hardened owner routines move overlapping default rows atomically so PostgreSQL can attach the partition safely.

### 21. Why use an advisory lock for retention?

Multiple app instances could otherwise perform the same maintenance concurrently. `pg_try_advisory_lock` elects one coordinator without blocking request traffic; others skip. The lock is session-scoped, so the same checked-out client performs work and releases it in cleanup.

### 22. Why bound retention work?

One cycle drops at most 32 partitions and makes at most ten 1,000-row default-deletion calls. Bounded work avoids monopolizing a connection or holding long transactions. `FOR UPDATE SKIP LOCKED` lets batches make progress without waiting on locked default rows. Backlog can require later cycles, which is reported in structured logs.

## Reliability, security, and operations

### 23. Why use separate migration-owner and runtime database roles?

Startup migrations and security-definer routine ownership need DDL privileges. Normal HTTP traffic needs only `SELECT` and `INSERT` plus narrowly granted routine execution. Separating roles limits damage if the runtime connection is compromised and makes privilege intent auditable.

### 24. How are database errors mapped to HTTP?

Known, narrowly allowlisted availability conditions become a generic HTTP 503 with `Retry-After: 30`. Valid client/application failures become stable 400 responses. Unexpected failures become a generic 500. SQL text, SQLSTATE details, credentials, request URLs, and submitted values are not returned to clients.

### 25. What controls are missing for an Internet-facing deployment?

Authentication, authorization, TLS termination, rate limiting, and a public body/batch ceiling. Compose binds locally, but production needs a gateway and secret management. Those omissions are documented; they are not silently presented as production-hardening features.

### 26. How does graceful shutdown preserve correctness?

Readiness is marked unavailable, Fastify stops accepting work, the retention run is aborted/stopped, and then the pool closes, all under a deadline. Repeated signals share one shutdown promise. This ordering avoids closing PostgreSQL underneath active maintenance.

## Testing and performance evidence

### 27. What does each test layer prove?

Unit tests prove validation, parsing, SQL construction, error mapping, scheduling, and load-generator accounting in isolation. PostgreSQL integration tests prove migrations, real SQL, JSONB behavior, partitions, retention, and repository transactions. Compose contract tests prove zero-config startup, public HTTP, exact limits, persistence, failure diagnostics, and cleanup. No single layer replaces the others.

### 28. Why is the final benchmark credible?

It drives public HTTP, counts confirmed accepts only, records failures/indeterminate rows, sends one million measured rows after warm-up, schedules aggregation open-loop at one request per second, verifies public-query freshness, reconciles exact PostgreSQL rows, inspects effective Docker limits and durable settings, records the source commit/environment, and verifies cleanup.

### 29. What was the bottleneck and retained optimization?

Evidence indicated the application was close to its 0.5-CPU allocation, with low client scheduling lag. Larger batches, concurrency eight, and disabling request logging did not improve end-to-end throughput. A strict round-trip fast path for canonical millisecond UTC timestamps reduced per-row validation/canonicalization work and reached 16,031.716 and 17,059.228 logs/s in two runs. This supports a bottleneck inference for that workload, not a universal proof.

### 30. Why not quote only the best benchmark run?

The lower independent retained run already passes, so the conclusion does not depend on cherry-picking 17,059.228. The report keeps the failed baseline and rejected experiments, uses exact row reconciliation, and documents host/sampling limitations.

## Checkpoint questions for the student

Answer these aloud without looking at the model answers:

1. Trace one valid and one invalid entry from JSON parsing to the final HTTP response.
2. Explain why HTTP 200 means more than “the client sent the request.”
3. Write the tuple predicate for the second descending cursor page and explain its `<` direction.
4. Explain why the filter fingerprint is useful even though the cursor is unsigned.
5. Defend the two-JSONB design against storing every attribute in columns or text.
6. Defend the current index inventory, then name evidence that would justify a GIN index.
7. Explain how the default partition helps availability and complicates retention.
8. Describe advisory-lock ownership and why a pool client matters.
9. Distinguish aggregation latency, aggregation scheduling lag, and freshness.
10. Name one limitation you would fix at a gateway and one you would investigate in PostgreSQL.
11. Explain why resource samples are observations but Docker `HostConfig` is limit evidence.
12. Propose one controlled experiment and list every variable you would hold constant.

After answering, compare your explanation with the [code walkthrough](code-walkthrough.md) and [final performance report](performance/final-report.md).
