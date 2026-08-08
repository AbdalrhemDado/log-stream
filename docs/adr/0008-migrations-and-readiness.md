# ADR 0008 — Migrations and Readiness

- **Status:** `PROPOSED — NOT APPROVED`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Stage 2 after approval

## Context

Plain `docker compose up` must initialize the complete service. Health may return `200` only after database connection, migrations, required schema preparation, and runtime-role permission verification are complete. Concurrent startup must not race migrations, and ordinary traffic must not use the PostgreSQL superuser or schema owner.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Small ordered SQL runner in the app | Exact SQL and automatic startup | Must implement history/checksums/locking correctly |
| Lightweight migration library | Mature bookkeeping | Adds library conventions and startup integration |
| Docker initialization scripts | Simple empty-volume creation | Do not manage upgrades to existing volumes |

Privilege alternatives are:

| Alternative | Advantages | Disadvantages |
|---|---|---|
| One non-superuser schema-owner login for startup and requests | Simple connection configuration | Request-path defects retain arbitrary application-schema DDL privileges |
| Separate migration-owner and restricted runtime logins | Limits ordinary traffic to reviewed operations | Requires grants, two credentials, and narrow ongoing-retention privileges |
| PostgreSQL superuser for application traffic | Avoids permission setup | Unacceptable cluster-wide blast radius and no justified runtime benefit |

## Proposed decision

**PROPOSED — not approved:** implement an ordered SQL-file runner with a migration history table, checksum, and PostgreSQL advisory lock. Apply each migration transactionally where supported. Use forward-fix migrations rather than automatic destructive rollback.

Bootstrap initialization creates distinct non-superuser migration-owner and runtime login roles using built-in Compose defaults. The owner role owns the application schema, migration history, tables, partitions, and narrowly scoped retention routines. Startup opens a short-lived owner connection for migrations and required partition preparation, then closes it. The ordinary `pg` pool connects as the runtime role with only required `CONNECT`, schema `USAGE`, `SELECT`, `INSERT`, narrowly needed mutation rights, and `EXECUTE` on approved retention routines.

Ongoing partition DDL should be exposed through tightly scoped owner-defined `SECURITY DEFINER` routines rather than owner membership or arbitrary runtime DDL. Those routines require a fixed safe `search_path`, schema-qualified objects, internal input validation, revoked `PUBLIC` execution, and an explicit runtime-role grant. Role separation reduces blast radius but does not provide complete security if the application process or startup owner credential is compromised.

Startup states are: bootstrap roles if the database is fresh → connect as owner → acquire migration lock → migrate → prepare required partitions/schema → close owner connection → connect as runtime → verify required operations/permissions → create server → listen. Readiness is false until all required work succeeds. Migration, grant, or permission-check failure keeps the service non-ready and logs a redacted actionable cause without credentials.

## Consequences

### Positive

- Exact DDL remains inspectable beside `EXPLAIN` work.
- Zero manual steps and idempotent restarts.
- Advisory lock protects multiple app instances.
- Ordinary request SQL cannot perform arbitrary schema-owner operations.

### Negative

- The project owns migration-runner correctness.
- Non-transactional DDL requires deliberate forward-fix handling.
- Two credentials and retention routines add setup and review complexity.
- The startup process still receives an owner credential unless later deployment isolation is added.

## Evidence and review gates

- Empty database, repeat startup, checksum mismatch, failed migration, and concurrent startup tests.
- Health must remain non-`200` until success.
- Role inspection proves neither application login is a superuser, the request pool uses the runtime role, required DML/retention operations succeed, and unrelated DDL fails.
- Retention-routine tests verify owner, fixed `search_path`, explicit grants, input validation, and revoked `PUBLIC` execution.
- Logs and errors are inspected for credential leakage.
- Persistent-volume upgrade test.

## References

- Requirements: `INF-001`, `HLT-001`, `HLT-002`, `CORE-002`, `SEC-001`, `SEC-002`, `SEC-003`, `DEL-002`
- Edge cases: `EDGE-RET-004`, `EDGE-BAT-009`
- Training: Learn SQL; Learn TypeScript; Learn Docker; Learn HTTP Servers in TypeScript

## Approval questions

1. Approve a small custom SQL runner rather than a migration library?
2. Approve forward-fix-only migration history for this project?
3. Approve separate non-superuser migration-owner/runtime roles and narrowly scoped retention routines?
