# ADR 0009 — Docker Runtime and Shutdown

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Stage 2 after explicit task authorization

## Context

A fresh checkout must start with plain `docker compose up`, expose the application at `localhost:8080`, and operate within the required application and PostgreSQL resource limits. Startup, readiness, signal handling, and shutdown must not claim success before data is durable or abandon work without a bounded policy.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Application and PostgreSQL in one container | Small visible container count | Couples lifecycles, complicates persistence and health, and works against normal container isolation |
| Separate application and PostgreSQL services in Compose | Independent health, resources, logs, and persistent storage | Requires explicit dependency/readiness handling |
| Application, PostgreSQL, and mandatory proxy/queue services | More deployment controls | Adds memory, CPU, startup states, and failure modes without a company requirement |

## Accepted decision

**ACCEPTED — 2026-08-08:** use two required Compose services: a non-root Node application container and a PostgreSQL container with a named data volume. Use PostgreSQL 16 as the compatibility baseline and pin an exact supported 16.x image tag or digest during Stage 2. Pin the Node implementation image, expose only application port `8080` to the host by default, and keep PostgreSQL on the internal Compose network.

Apply the specified CPU and memory limits in the Compose configuration and verify that the chosen Compose mode enforces them. Use an exec-form application command and an init process or equivalent correct PID 1 behavior. On `SIGTERM`, stop accepting new requests, mark readiness false, allow a measured bounded grace period for in-flight requests/transactions, close the database pool, and exit. PostgreSQL receives its own normal Compose stop sequence.

No proxy, queue, dashboard, or migration sidecar is part of the required baseline.

## Consequences

### Positive

- Matches the zero-manual-step company startup contract.
- Keeps database persistence and resource accounting explicit.
- Bounded draining reduces false ingestion success and abrupt connection loss.

### Negative

- Correct readiness and signal behavior require integration tests.
- Compose resource syntax and enforcement can differ by Docker environment.
- In-flight requests may still fail if they exceed the documented grace period.

## Evidence and review gates

- Fresh-volume and persistent-volume `docker compose up` smoke tests.
- Host connectivity only through `localhost:8080` in the default design.
- Startup, database-unavailable, `SIGTERM`, in-flight ingestion, and restart tests.
- Record actual resource-limit configuration and observed usage during later load tests; do not infer enforcement from configuration alone.

## References

- Requirements: `INF-001`, `INF-002`, `INF-003`, `HLT-001`, `HLT-002`, `DEL-002`, `PERF-007`
- Edge cases: `EDGE-BAT-007`, `EDGE-BAT-008`, `EDGE-BAT-011`, `EDGE-RET-005`
- Training: Learn Docker; Learn HTTP Servers in TypeScript; Learn HTTP Clients in TypeScript; Learn TypeScript

## Acceptance record

The reviewer approved the two-service Compose baseline, PostgreSQL 16 compatibility baseline, and bounded graceful-draining policy on `2026-08-08`. Exact image and shutdown-timeout values remain Stage 2 implementation selections subject to validation.
