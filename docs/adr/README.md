# Architecture Decision Records

## Status

Every ADR in this directory is currently `PROPOSED — NOT APPROVED`.

An ADR may move to `ACCEPTED` only after explicit user approval. Acceptance authorizes the decision for its scheduled implementation task; it does not authorize unrelated implementation, commits, pushes, or merges.

Performance-sensitive ADRs remain subject to later evidence. An accepted baseline may be superseded by a new ADR when measured results justify a change.

## Proposed records

| ADR | Decision | Primary requirements |
|---|---|---|
| [0001](./0001-http-framework-and-module-boundaries.md) | HTTP framework and module boundaries | `CORE-001`, `INF-002`, `CI-001` |
| [0002](./0002-postgresql-access-and-safe-query-construction.md) | PostgreSQL access and safe query construction | `CORE-002`, `SEC-001`, `SEC-002` |
| [0003](./0003-log-schema-and-attribute-storage.md) | Log schema and attribute storage | `ING-003`–`ING-008`, `QRY-005`, `QRY-012` |
| [0004](./0004-identifiers-ordering-and-cursors.md) | Identifiers, deterministic ordering, and cursor semantics | `QRY-010`–`QRY-018` |
| [0005](./0005-evidence-gated-indexing.md) | Evidence-gated indexing | `QRY-001`–`QRY-010`, `PERF-001`–`PERF-004` |
| [0006](./0006-partitioning-and-retention.md) | Partitioning and retention | `RET-001`–`RET-003`, `PERF-003`, `PERF-004` |
| [0007](./0007-bulk-ingestion-and-connection-pooling.md) | Bulk ingestion and connection pooling | `ING-013`, `PERF-001`, `PERF-005` |
| [0008](./0008-migrations-and-readiness.md) | Migrations and readiness | `INF-001`, `HLT-001`, `HLT-002` |
| [0009](./0009-docker-runtime-and-shutdown.md) | Docker runtime and shutdown | `INF-001`–`INF-003`, `DEL-002` |
| [0010](./0010-error-handling-and-security.md) | Error handling and security boundaries | `SEC-001`–`SEC-003`, `ING-012`, `QRY-015` |
| [0011](./0011-testing-and-performance-validation.md) | Testing and performance validation | `CI-001`, `PERF-001`–`PERF-007` |
| [0012](./0012-optional-additions-posture.md) | Optional additions posture | `OPT-001`–`OPT-007` |

## Record template

Each ADR includes:

- status;
- context and decision drivers;
- realistic alternatives;
- proposed decision;
- positive and negative consequences;
- validation/measurement gates;
- requirement and edge-case references;
- approval questions.

The detailed cross-decision analysis and Mermaid diagrams are in [`../architecture-proposal.md`](../architecture-proposal.md).
