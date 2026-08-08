# Architecture Decision Records

## Status

Every ADR in this directory was accepted by the reviewer/architect on `2026-08-08`.

Acceptance records the architecture baseline for its scheduled implementation task. It does not prove implementation, correctness, or performance, and it does not authorize unrelated work, commits, pushes, or merges.

Performance-sensitive ADRs remain subject to later evidence. An accepted baseline may be superseded by a new ADR when measured results justify a change.

## Accepted records

| ADR | Decision | Primary requirements | Status | Decision date |
|---|---|---|---|---|
| [0001](./0001-http-framework-and-module-boundaries.md) | HTTP framework and module boundaries | `CORE-001`, `INF-002`, `CI-001` | ACCEPTED | `2026-08-08` |
| [0002](./0002-postgresql-access-and-safe-query-construction.md) | PostgreSQL access and safe query construction | `CORE-002`, `SEC-001`, `SEC-002` | ACCEPTED | `2026-08-08` |
| [0003](./0003-log-schema-and-attribute-storage.md) | Log schema and attribute storage | `ING-003`–`ING-008`, `QRY-005`, `QRY-012` | ACCEPTED | `2026-08-08` |
| [0004](./0004-identifiers-ordering-and-cursors.md) | Identifiers, deterministic ordering, and cursor semantics | `QRY-010`–`QRY-018` | ACCEPTED | `2026-08-08` |
| [0005](./0005-evidence-gated-indexing.md) | Evidence-gated indexing | `QRY-001`–`QRY-010`, `PERF-001`–`PERF-004` | ACCEPTED | `2026-08-08` |
| [0006](./0006-partitioning-and-retention.md) | Partitioning and retention | `RET-001`–`RET-003`, `PERF-003`, `PERF-004` | ACCEPTED | `2026-08-08` |
| [0007](./0007-bulk-ingestion-and-connection-pooling.md) | Bulk ingestion and connection pooling | `ING-013`, `PERF-001`, `PERF-005` | ACCEPTED | `2026-08-08` |
| [0008](./0008-migrations-and-readiness.md) | Migrations and readiness | `INF-001`, `HLT-001`, `HLT-002` | ACCEPTED | `2026-08-08` |
| [0009](./0009-docker-runtime-and-shutdown.md) | Docker runtime and shutdown | `INF-001`–`INF-003`, `DEL-002` | ACCEPTED | `2026-08-08` |
| [0010](./0010-error-handling-and-security.md) | Error handling and security boundaries | `SEC-001`–`SEC-003`, `ING-012`, `QRY-015` | ACCEPTED | `2026-08-08` |
| [0011](./0011-testing-and-performance-validation.md) | Testing and performance validation | `CI-001`, `PERF-001`–`PERF-007` | ACCEPTED | `2026-08-08` |
| [0012](./0012-optional-additions-posture.md) | Optional additions posture | `OPT-001`–`OPT-007` | ACCEPTED | `2026-08-08` |

## Record template

Each ADR includes:

- status;
- context and decision drivers;
- realistic alternatives;
- accepted decision and date;
- positive and negative consequences;
- validation/measurement gates;
- requirement and edge-case references;
- acceptance record.

The detailed accepted architecture analysis and Mermaid diagrams are in [`../architecture-proposal.md`](../architecture-proposal.md).
