# Staged Project Backlog

## Working agreement

- Work on one task at a time and stop for approval at each checkpoint.
- Create a task branch only when its task starts.
- Do not commit, push, merge, rewrite history, or delete branches without explicit approval.
- Review `docs/company-requirements.md`, the relevant requirement IDs in `requirements-traceability.md`, and applicable edge cases before implementation.
- Do not advance performance requirements without actual load evidence and PostgreSQL row-count reconciliation.
- Architecture choices require alternatives, trade-offs, an approved recommendation, and an ADR where appropriate.

Suggested branches are planning guidance, not authorization to create them. Completion criteria are cumulative with applicable format, lint, type-check, test, contract, Docker, documentation, and learning gates.

## Stage 0 — Requirements, risks, and learning plan

### Task 0.1 — Requirement traceability

- **Status:** Completed and merged to `main` in merge commit `f1a76ee`.
- **Goal:** Establish the authoritative requirement baseline, edge cases, staged work, and terminology before architecture or code.
- **Relevant requirement IDs:** All requirements; especially `INF-001`, `ING-001`–`ING-015`, `QRY-001`–`QRY-018`, `AGG-001`–`AGG-008`, `RET-001`–`RET-003`, and `PERF-001`–`PERF-007`.
- **Dependencies:** Initial company specification and repository instructions.
- **Expected output:** `docs/requirements-traceability.md`, `docs/edge-case-matrix.md`, and `docs/backlog.md`.
- **Training subjects:** Requirements engineering, TypeScript types as documentation, HTTP contracts/status codes, introductory SQL query requirements, Git traceability.
- **Suggested branch:** `docs/requirements-analysis`
- **Completion criteria:** Every company requirement has a stable ID and planned evidence; project decisions are not mislabeled as company requirements; unresolved architecture is deferred; documentation diff passes review.

### Task 0.2 — Architecture proposal and ADR plan

- **Status:** Completed and merged through [PR #2](https://github.com/AbdalrhemDado/log-stream/pull/2) in merge commit `056b16cacefa8f1f595d652865fb6c0269b72d90`.
- **Goal:** Compare reasonable system designs and obtain approval for the high-level architecture without writing production code.
- **Relevant requirement IDs:** `CORE-001`, `CORE-002`, `INF-001`–`INF-003`, `HLT-001`–`HLT-003`, `ING-013`, `QRY-005`, `QRY-010`–`QRY-014`, `AGG-002`–`AGG-004`, `RET-001`–`RET-003`, `SEC-001`–`SEC-003`, `PERF-001`–`PERF-006`.
- **Dependencies:** Task 0.1 approved and committed.
- **Expected output:** High-level/component/data-flow diagrams and ADR proposals covering framework, SQL access, schema/attributes, IDs/cursors, indexes, partitioning/retention, migrations, testing, deployment, and optional-feature posture.
- **Training subjects:** System design, TypeScript service boundaries, HTTP request flows, PostgreSQL storage/index fundamentals, Docker topology, performance bottleneck analysis, security boundaries.
- **Suggested branch:** After Task 0.1 is merged to `main`, create the fresh branch `docs/architecture-design` so requirements analysis and architecture design remain separate reviewable units in Git/GitHub history.
- **Completion criteria:** At least two alternatives for every major decision; advantages/disadvantages and student-friendly recommendation; bottlenecks and measurement plans identified; decisions approved before implementation.

## Stage 1 — Repository and TypeScript foundation

### Task 1.1 — Project scaffold

- **Status:** Completed and merged through [PR #3](https://github.com/AbdalrhemDado/log-stream/pull/3) in merge commit `3f1960d8640ba77602f58d41d014ec65dff92695`.
- **Goal:** Create the smallest strict TypeScript HTTP-service foundation and developer toolchain.
- **Relevant requirement IDs:** `CORE-001`, `INF-002`, `CI-001`, `DEL-001`, `DOC-001`.
- **Dependencies:** Approved Stage 0 architecture decisions affecting framework and project structure.
- **Expected output:** Package scripts, pinned dependencies/runtime, strict TypeScript configuration, formatting/linting/test setup, app/server separation, typed configuration shell, logging foundation, `.gitignore`, and `.editorconfig`.
- **Training subjects:** TypeScript strict mode, modules, `unknown` versus `any`, server lifecycle, npm scripts, Git hygiene.
- **Suggested branch:** `chore/bootstrap`
- **Completion criteria:** Format, lint, type-check, unit-test, and build commands exist and pass; no application feature or database design is implemented prematurely.

### Task 1.2 — Error and shutdown foundation

- **Status:** Completed as `7eceb267fa94dcf3b843959d7541ba271e83f29a` and merged through [PR #3](https://github.com/AbdalrhemDado/log-stream/pull/3) in merge commit `3f1960d8640ba77602f58d41d014ec65dff92695`.
- **Goal:** Establish safe error mapping, request correlation, and graceful process shutdown.
- **Relevant requirement IDs:** `HLT-001`, `SEC-003`, `REL-001`, `ING-012`, `QRY-015`, `AGG-008`.
- **Dependencies:** Task 1.1.
- **Expected output:** Typed application errors, consistent public error envelopes where required, redacted logs, request IDs, and SIGTERM/SIGINT lifecycle hooks.
- **Training subjects:** TypeScript error narrowing, async error propagation, HTTP `400`/`500`/`503`, process signals, safe logging.
- **Suggested branch:** Continue `chore/bootstrap` or a focused `feat/error-foundation` branch after checkpoint approval.
- **Completion criteria:** Error-mapper tests pass; public responses expose no stack traces/secrets; shutdown hooks close the server safely in tests where practical.

## Stage 2 — PostgreSQL, migrations, Docker, and readiness

### Task 2.1 — Docker Compose foundation

- **Status:** Completed and pushed on `feat/database-foundation` as `6b0672ad5ba4a5282d58698ab8090b795278a330` (`feat: add Docker and database readiness foundation`); the Stage 2 branch is not yet merged.
- **Goal:** Make the application and PostgreSQL start reproducibly with the required ports, defaults, health checks, and resource profile.
- **Relevant requirement IDs:** `CORE-002`, `INF-001`–`INF-003`, `HLT-001`, `DEL-002`, `OPT-002`.
- **Dependencies:** Stage 1 foundation and approved deployment architecture.
- **Expected output:** Production-oriented multi-stage Dockerfile, Compose services/network/volume, non-root app user, health checks, and programmatic database wait behavior.
- **Training subjects:** Docker images/containers, build stages, networks, volumes, Compose health checks, readiness versus liveness, resource constraints.
- **Suggested branch:** `feat/database-foundation`
- **Completion criteria:** A clean environment starts with `docker compose up`; `localhost:8080` is reachable when ready; no `.env` or manual setup is required; startup behavior is documented and tested.

### Task 2.2 — Migration runner

- **Status:** In progress on `feat/database-foundation`; implementation and validation are complete but uncommitted and unpushed pending review.
- **Goal:** Apply ordered database migrations safely before readiness.
- **Relevant requirement IDs:** `CORE-002`, `INF-001`, `HLT-001`, `HLT-002`, `SEC-001`, `SEC-003`, `DEL-002`.
- **Dependencies:** Task 2.1 and approved migration-tooling ADR.
- **Expected output:** Migration mechanism, migration history, concurrency protection, failure handling, and empty-database integration tests.
- **Training subjects:** PostgreSQL transactions and locks, idempotent startup, TypeScript async database code, Docker startup ordering.
- **Suggested branch:** Continue `feat/database-foundation`.
- **Completion criteria:** Migrations apply automatically from an empty database; concurrent startup is safe; failure prevents readiness; repeat startup is idempotent.

### Task 2.3 — Initial schema and indexes

- **Goal:** Implement only the approved initial storage design and minimal justified indexes.
- **Relevant requirement IDs:** `CORE-002`, `ING-004`–`ING-008`, `QRY-005`, `QRY-010`–`QRY-012`, `RET-001`, `SEC-001`, `PERF-001`–`PERF-005`.
- **Dependencies:** Task 2.2 and approved schema/attribute/ID/index/partition ADRs from Stage 0.2.
- **Expected output:** Schema migration, constraints, initial indexes, schema inspection command, and integration tests.
- **Training subjects:** PostgreSQL DDL, `TIMESTAMPTZ`, constraints, JSONB alternatives, B-tree/GIN/trigram concepts, partitions, write amplification.
- **Suggested branch:** Continue `feat/database-foundation`.
- **Completion criteria:** Empty-database migration and schema tests pass; every initial index is justified by a query pattern; unmeasured performance claims are absent.

## Stage 3 — Domain types and per-entry validation

### Task 3.1 — Domain model

- **Goal:** Represent untrusted input, validated logs, rejections, persistence records, and API responses with strong types.
- **Relevant requirement IDs:** `ING-001`–`ING-012`, `QRY-011`, `QRY-012`.
- **Dependencies:** Stage 1 foundation and approved edge-case decisions needed by the model.
- **Expected output:** Domain types using `unknown`, readonly structures, and discriminated validation results without unsafe `any`.
- **Training subjects:** TypeScript discriminated unions, type guards, literal unions, `Record`, readonly data, transport versus domain types.
- **Suggested branch:** `feat/log-ingestion`
- **Completion criteria:** Strict type-check passes; transport input remains untrusted; response and rejection models reflect the contract without embedding framework objects.

### Task 3.2 — Entry validator

- **Goal:** Implement independent, deterministic runtime validation for every ingestion entry.
- **Relevant requirement IDs:** `ING-003`–`ING-010`, `ING-014`, `ING-015`; decisions `DEC-002`, `DEC-003`, `DEC-004`, `DEC-006`.
- **Dependencies:** Task 3.1 and the accepted timestamp grammar in `DEC-006`.
- **Expected output:** Pure validator with stable rejection reasons and table-driven tests for every validation edge case.
- **Training subjects:** Runtime narrowing, pure functions, ISO timestamp validation, boundary testing, compile-time versus runtime safety.
- **Suggested branch:** Continue `feat/log-ingestion`.
- **Completion criteria:** Tests cover missing/wrong/empty fields, level values, time boundary, attributes, unknown fields, whitespace decisions, and consistent request-time handling.

### Task 3.3 — Attribute normalization

- **Goal:** Implement only the attribute transformation approved by the storage ADR while preserving API value types.
- **Relevant requirement IDs:** `ING-006`–`ING-008`, `QRY-005`, `QRY-012`.
- **Dependencies:** Task 3.2 and approved Stage 0.2 attribute-storage ADR.
- **Expected output:** Typed normalization logic and tests for strings, numbers, booleans, missing attributes, and `{}` query-response compatibility.
- **Training subjects:** TypeScript records, JSON value types, deterministic conversion, PostgreSQL JSONB semantics.
- **Suggested branch:** Continue `feat/log-ingestion`.
- **Completion criteria:** Original values round-trip; search semantics match the approved design; missing attributes can produce `attributes: {}`; no unsupported value is normalized silently.

## Stage 4 — High-throughput ingestion

### Task 4.1 — Ingestion repository

- **Goal:** Persist validated batches efficiently and durably using the approved, measured initial bulk strategy.
- **Relevant requirement IDs:** `CORE-002`, `ING-009`, `ING-013`, `SEC-001`, `REL-001`, `PERF-001`, `PERF-005`.
- **Dependencies:** Stage 2 schema, Stage 3 validated persistence records, and approved ingestion/data-access ADR.
- **Expected output:** Framework-independent repository, parameterized bulk insert, explicit transaction/commit behavior, database error translation, and integration tests.
- **Training subjects:** SQL bulk insertion alternatives, transactions/commits, parameterization, connection pools, async repositories, durability.
- **Suggested branch:** `feat/log-ingestion`
- **Completion criteria:** No per-row insertion loop without evidence; success follows commit; failure tests reconcile stored rows; SQL values are parameterized.

### Task 4.2 — `POST /logs`

- **Goal:** Expose the exact ingestion contract with top-level validation, independent entries, partial acceptance, and durability-aware responses.
- **Relevant requirement IDs:** `ING-001`–`ING-015`, `SEC-003`, `REL-001`; decisions `DEC-001`–`DEC-004`, `DEC-016`.
- **Dependencies:** Tasks 3.2, 3.3, and 4.1; accepted database-failure behavior in `DEC-016`.
- **Expected output:** Route/service wiring plus unit, integration, and black-box contract tests for valid, mixed, invalid, malformed, unknown-field, and database-failure cases.
- **Training subjects:** HTTP body parsing, status codes, request lifecycle, partial success, TypeScript error handling, transaction failure flow.
- **Suggested branch:** Continue `feat/log-ingestion`.
- **Completion criteria:** Exact status/response behavior passes; original rejection indexes are preserved; no false `200`; unknown fields follow approved compatibility decisions.

### Task 4.3 — Initial ingestion microbenchmark

- **Goal:** Record a reproducible functional baseline for validation, normalization, and database insertion without claiming final throughput.
- **Relevant requirement IDs:** `PERF-001`, `PERF-004`, `PERF-005`, `PERF-007`, `INF-003`.
- **Dependencies:** Task 4.2.
- **Expected output:** Repeatable benchmark command and baseline report with environment/configuration and row verification.
- **Training subjects:** Benchmark design, warm-up, throughput, allocation cost, client versus server bottlenecks, evidence discipline.
- **Suggested branch:** Continue `feat/log-ingestion` or `perf/ingestion-baseline` after approval.
- **Completion criteria:** Commands and configuration are recorded; accepted counts match PostgreSQL; results are labeled baseline, not final target proof.

## Stage 5 — Query parsing, safe SQL, and cursor pagination

### Task 5.1 — Query parameter parser

- **Goal:** Convert untrusted query strings into one safe typed filter model shared with aggregation.
- **Relevant requirement IDs:** `QRY-001`–`QRY-009`, `QRY-015`–`QRY-017`, `AGG-004`; decisions `DEC-007`–`DEC-011`.
- **Dependencies:** Stage 1 foundation and accepted query decisions `DEC-007`–`DEC-011`.
- **Expected output:** Pure parser and exhaustive table-driven tests for recognized, combined, malformed, duplicate, and unknown parameters.
- **Training subjects:** HTTP query encoding, TypeScript narrowing, exact integer parsing, time ranges, client/server contract boundaries.
- **Suggested branch:** `feat/log-query`
- **Completion criteria:** All documented filters parse safely; recognized invalid values return the required error shape; unknowns follow the compatibility decision.

### Task 5.2 — Safe predicate builder

- **Goal:** Build reusable list/aggregation predicates without interpolating user-controlled SQL.
- **Relevant requirement IDs:** `QRY-001`–`QRY-008`, `AGG-004`, `SEC-001`, `SEC-002`.
- **Dependencies:** Task 5.1 and approved attribute/query storage design.
- **Expected output:** Pure `{ text, values }` builder with predictable parameter ordering, literal substring behavior, and injection tests.
- **Training subjects:** Parameterized SQL, `WHERE`/`AND`, JSONB querying, literal `ILIKE` semantics, pure immutable functions.
- **Suggested branch:** Continue `feat/log-query`.
- **Completion criteria:** Every user value remains in the parameter array; SQL text/values tests cover every filter and malicious payloads.

### Task 5.3 — Cursor codec

- **Goal:** Implement the approved opaque cursor contract and validate malformed or incompatible cursors.
- **Relevant requirement IDs:** `QRY-010`, `QRY-013`–`QRY-015`, `QRY-018`; decision `DEC-014`.
- **Dependencies:** Stage 0.2 ID/cursor ADR, Task 5.1 normalized filters, and Stage 2 schema.
- **Expected output:** Cursor encoder/decoder and tests for round trip, malformed input, version/integrity behavior, equal timestamps, and filter compatibility as approved.
- **Training subjects:** Keyset pagination, opaque tokens, serialization, integrity trade-offs, TypeScript result types.
- **Suggested branch:** Continue `feat/log-query`.
- **Completion criteria:** Cursor behavior matches its ADR; invalid cursors return safe validation failures; no database/internal data leaks unnecessarily.

### Task 5.4 — Query repository and `GET /logs`

- **Goal:** Return deterministic pages with all approved filters and stable response fields.
- **Relevant requirement IDs:** `QRY-001`–`QRY-018`, `SEC-001`, `PERF-003`, `PERF-005`.
- **Dependencies:** Tasks 5.1–5.3 and approved schema/index decisions.
- **Expected output:** Repository, route/service, response mapper, and multi-page integration/contract tests.
- **Training subjects:** SQL ordering and keyset predicates, `limit + 1`, timestamp serialization, HTTP response shaping, query plans.
- **Suggested branch:** Continue `feat/log-query`.
- **Completion criteria:** No duplicates/missing rows under documented semantics; equal timestamps are stable; final cursor is null; missing ingestion attributes return `{}`.

## Stage 6 — Time-bucketed aggregation

### Task 6.1 — Aggregation parameter parser

- **Goal:** Validate aggregation-only parameters while reusing shared filter semantics.
- **Relevant requirement IDs:** `AGG-001`–`AGG-004`, `AGG-008`, `QRY-003`–`QRY-008`, `QRY-017`.
- **Dependencies:** Task 5.1.
- **Expected output:** Typed aggregation request model and tests for required, optional, valid, invalid, and edge-case values.
- **Training subjects:** HTTP query validation, TypeScript literal unions/exhaustive maps, time-range boundaries.
- **Suggested branch:** `feat/log-aggregation`
- **Completion criteria:** Four buckets and two groupings validate exactly; missing/invalid input produces required `400` errors.

### Task 6.2 — Aggregation SQL and endpoint

- **Goal:** Implement safe time-bucketed counts with optional grouping and shared filters.
- **Relevant requirement IDs:** `AGG-001`–`AGG-008`, `SEC-001`, `SEC-002`, `PERF-002`, `PERF-006`.
- **Dependencies:** Task 6.1, Task 5.2, and approved database/index/bucketing design.
- **Expected output:** Whitelisted bucket/group expressions, repository/route, count conversion, and integration/contract tests.
- **Training subjects:** SQL `GROUP BY`, `COUNT`, time bucketing, whitelist versus parameterization, PostgreSQL bigint mapping.
- **Suggested branch:** Continue `feat/log-aggregation`.
- **Completion criteria:** All buckets/groups/filters work; output order and null group match contract; injection tests and boundary tests pass.

### Task 6.3 — `EXPLAIN ANALYZE` review

- **Goal:** Inspect real execution plans for primary list and aggregation patterns before tuning claims.
- **Relevant requirement IDs:** `PERF-002`–`PERF-004`, `PERF-007`, `DOC-001`, `DEL-003`.
- **Dependencies:** Tasks 5.4 and 6.2 with representative data.
- **Expected output:** Repeatable explain script and documented plans for unfiltered, service, level, attribute, message, and aggregation queries.
- **Training subjects:** Sequential/index/bitmap scans, estimates, planning/execution time, partition pruning, index trade-offs.
- **Suggested branch:** Continue `feat/log-aggregation` or `perf/query-plan-baseline` after approval.
- **Completion criteria:** Plans are captured from actual commands, interpreted accurately, and linked to future evidence-driven tuning tasks.

## Stage 7 — Retention without ingestion disruption

### Task 7.1 — Retention service

- **Goal:** Implement the approved configurable retention design without materially disrupting request traffic.
- **Relevant requirement IDs:** `RET-001`–`RET-003`, `REL-001`, `PERF-003`, `SEC-003`; decision `DEC-015`.
- **Dependencies:** Approved retention ADR, Stage 2 database lifecycle, and decisions for old-ingest/cutoff semantics.
- **Expected output:** Bounded cleanup lifecycle, coordination/observability appropriate to the approved design, startup/interval integration, and graceful cancellation.
- **Training subjects:** PostgreSQL deletes/partitions/locks/WAL/vacuum/bloat, timers, cancellation, failure handling, Docker process lifecycle.
- **Suggested branch:** `feat/retention`
- **Completion criteria:** Expired data is removed, recent data preserved, failures are observable, cleanup is concurrency-safe, and request handling remains available.

### Task 7.2 — Retention tests

- **Goal:** Prove retention boundaries, safety, failure behavior, and lifecycle behavior.
- **Relevant requirement IDs:** `RET-001`–`RET-003`, `REL-001`, `PERF-003`.
- **Dependencies:** Task 7.1.
- **Expected output:** Integration tests for cutoff boundaries, old/recent data, concurrent workers, failure, shutdown, and any out-of-window storage path.
- **Training subjects:** Database integration testing, time control, concurrency, locks, background-worker lifecycle.
- **Suggested branch:** Continue `feat/retention`.
- **Completion criteria:** Tests cover every approved retention edge case; no unmeasured claim is made about ingestion impact.

## Stage 8 — Contract, failure, and security suite

### Task 8.1 — Black-box contract tests

- **Goal:** Validate the exact required API against the running Docker Compose system without implementation knowledge.
- **Relevant requirement IDs:** `INF-001`, `INF-002`, `HLT-001`–`HLT-003`, `ING-001`–`ING-015`, `QRY-001`–`QRY-018`, `AGG-001`–`AGG-008`, `OPT-001`, `OPT-002`.
- **Dependencies:** Stages 2–7 core endpoints and lifecycle.
- **Expected output:** External contract suite covering success, validation, pagination, aggregation, malformed input, and concurrent smoke behavior.
- **Training subjects:** TypeScript HTTP clients, black-box testing, Docker-composed systems, response schema assertions.
- **Suggested branch:** `test/contract-suite`
- **Completion criteria:** Tests use only public HTTP behavior; exact required fields/statuses pass from a clean Compose startup.

### Task 8.2 — Failure and security tests

- **Goal:** Exercise hostile input and infrastructure failures without data-integrity or information-disclosure regressions.
- **Relevant requirement IDs:** `ING-013`, `SEC-001`–`SEC-003`, `REL-001`, `REL-002`, `HLT-002`.
- **Dependencies:** Task 8.1 and failure hooks/environments appropriate to the implementation.
- **Expected output:** SQL-injection suite, database startup/interruption tests, reasonable oversized requests, redaction checks, and graceful termination tests.
- **Training subjects:** Threat modeling, SQL injection, failure injection, backpressure, process signals, secret/stack-trace leakage.
- **Suggested branch:** Continue `test/contract-suite`.
- **Completion criteria:** Every string input has injection coverage; failures never produce false success or leaked internals; shutdown is safe under ordinary traffic.

## Stage 9 — Load generation, profiling, and performance tuning

### Task 9.1 — Reproducible TypeScript load generator

- **Goal:** Create an external, verifiable client that measures ingestion and concurrent aggregation accurately.
- **Relevant requirement IDs:** `PERF-001`–`PERF-007`, `REL-001`, `INF-003`.
- **Dependencies:** Stable core contract and Task 8.1.
- **Expected output:** Configurable seeded workload, batch/concurrency controls, one aggregation request per second, latency percentiles, error accounting, and machine-readable reports.
- **Training subjects:** HTTP client concurrency, statistics/percentiles, coordinated omission, warm-up, deterministic data, CLI design.
- **Suggested branch:** `perf/load-generator`
- **Completion criteria:** Client results reconcile with HTTP accepted totals and PostgreSQL row counts; configuration and methodology are reproducible.

### Task 9.2 — One-million-row benchmark

- **Goal:** Measure the mandatory workload under the exact application and PostgreSQL resource limits.
- **Relevant requirement IDs:** `INF-003`, `PERF-001`–`PERF-007`, `REL-001`.
- **Dependencies:** Task 9.1 and stable contract/security suites.
- **Expected output:** Controlled run record containing commit, configuration, database state, dataset, throughput, p50/p95/p99, resources, query plans, row reconciliation, and bottlenecks.
- **Training subjects:** Experimental control, resource monitoring, latency interpretation, bottleneck diagnosis, PostgreSQL plan analysis.
- **Suggested branch:** Continue `perf/load-generator` for tooling/reporting; do not mix tuning changes into the baseline commit.
- **Completion criteria:** Approximately one million rows are verified; concurrent query rate is present; no target is claimed without actual evidence.

### Task 9.3 — Evidence-driven tuning

- **Goal:** Improve measured bottlenecks one controlled variable at a time without weakening correctness or durability.
- **Relevant requirement IDs:** `PERF-001`–`PERF-007`, `REL-001`, `SEC-001`, `ING-013`, `RET-002`.
- **Dependencies:** Task 9.2 baseline.
- **Expected output:** Focused experiments with hypotheses, before/after evidence, query plans, reliability checks, and reversion of harmful changes.
- **Training subjects:** PostgreSQL/app profiling, index write amplification, pool/batch tuning, statistical comparison, durability settings.
- **Suggested branch:** One branch per accepted experiment, such as `perf/ingestion-tuning` or `perf/query-tuning`.
- **Completion criteria:** Each retained change improves a measured goal without contract, durability, or resource regressions; final report records unsuccessful experiments honestly.

## Stage 10 — CI, documentation, and submission polish

### Task 10.1 — GitHub Actions

- **Goal:** Automate meaningful code, database, Docker, and contract quality gates.
- **Relevant requirement IDs:** `CI-001`, `OPT-007`, `DEL-001`, `DEL-002`.
- **Dependencies:** Stable scripts and test suites from Stages 1–9.
- **Expected output:** Lockfile install, format, lint, type-check, unit, build, PostgreSQL integration, Compose startup/health, contract smoke, and shutdown jobs; conditional auth matrix if needed.
- **Training subjects:** GitHub Actions, CI service dependencies, caching, failure diagnosis, branch protection concepts.
- **Suggested branch:** `ci/github-actions`
- **Completion criteria:** Pipeline passes from a clean checkout; failures are actionable; enabled optional configurations are covered exactly as required.

### Task 10.2 — Final README and performance report

- **Goal:** Document exact setup, contract, approved design, evidence, limitations, and optional defaults without unsupported claims.
- **Relevant requirement IDs:** `DOC-001`, `PERF-007`, `OPT-001`–`OPT-007`, `DEL-002`, `DEL-003`.
- **Dependencies:** Implemented core, approved ADRs, passing CI, and completed load evidence.
- **Expected output:** Final README and performance documentation with diagrams, curl examples, schema/index/attribute/cursor/retention explanations, test commands, measured results, and limitations.
- **Training subjects:** Technical writing, architecture communication, benchmark reporting, API documentation, honest limitations.
- **Suggested branch:** `docs/final-readme`
- **Completion criteria:** Documentation checklist passes; every number is traceable to an actual command/report; zero-configuration behavior is explicit.

### Task 10.3 — Demo and interview package

- **Goal:** Prepare the student to explain and demonstrate the system independently in approximately five minutes.
- **Relevant requirement IDs:** `DEL-003`, `DEL-004`, `DOC-001`, `PERF-007`.
- **Dependencies:** Task 10.2 and final implementation evidence.
- **Expected output:** Timed demo script, interview questions/model answers, code walkthrough, and live-debug checklist.
- **Training subjects:** Architecture storytelling, HTTP/SQL trace walkthroughs, `EXPLAIN ANALYZE`, trade-off defense, live debugging.
- **Suggested branch:** Continue `docs/final-readme` or `docs/demo-package` after approval.
- **Completion criteria:** Timed rehearsal fits approximately five minutes; student can trace ingestion/query flows and explain major decisions without reading generated text.

## Stage 11 — Optional additions after the measured core passes

Optional tasks may start only after the required contract, CI, and performance evidence pass. Select at most two initially.

### Task 11.1 — Operational metrics

- **Goal:** Add bounded-cardinality operational visibility without changing required response bodies.
- **Relevant requirement IDs:** `OPT-001`, `OPT-002`, `DOC-001`, `REL-001`.
- **Dependencies:** Completed and measured core.
- **Expected output:** Additive metrics endpoint and documentation for ingestion/query/database/retention/process measurements.
- **Training subjects:** Observability, histograms/counters, label cardinality, performance overhead.
- **Suggested branch:** `feat/metrics`
- **Completion criteria:** Required contract remains unchanged; arbitrary services/messages/attributes never become labels; overhead is measured and documented.

### Task 11.2 — Diagnostics/status endpoint

- **Goal:** Expose safe read-only operational data useful for demonstration and debugging.
- **Relevant requirement IDs:** `OPT-001`, `OPT-002`, `SEC-003`, `DOC-001`.
- **Dependencies:** Completed and measured core.
- **Expected output:** Additive endpoint for safe row/size/partition/retention/version/feature data as applicable to the approved architecture.
- **Training subjects:** PostgreSQL catalog queries, approximate statistics, information disclosure, response design.
- **Suggested branch:** `feat/diagnostics`
- **Completion criteria:** No secrets or raw database errors are exposed; required endpoints and performance remain compatible; default state is documented.

### Task 11.3 — Minimal static dashboard

- **Goal:** Provide a small client of the existing API without delaying or modifying the core contract.
- **Relevant requirement IDs:** `OPT-001`, `OPT-002`, `DOC-001`.
- **Dependencies:** Completed and measured core; explicit selection as an optional addition.
- **Expected output:** Filters, recent logs, aggregation display, cursor navigation, and clear loading/error states.
- **Training subjects:** HTTP clients, browser state, accessible UI basics, pagination clients.
- **Suggested branch:** `feat/dashboard`
- **Completion criteria:** Dashboard uses public endpoints only; core responses remain unchanged; frontend work has no material backend performance regression.

### Task 11.4 — Authentication/API keys

- **Goal:** Add optional authentication only while preserving the exact default and seeded load-generator contracts.
- **Relevant requirement IDs:** `HLT-003`, `OPT-001`–`OPT-007`, `SEC-003`.
- **Dependencies:** Completed/measured core and explicit approval to implement auth.
- **Expected output:** Disabled-by-default feature flag, bearer auth, optional idempotent seeded key, scopes/status codes, migrations as needed, dual-mode CI, and documentation.
- **Training subjects:** Authentication versus authorization, credential hashing/storage, bearer transport, `401` versus `403`, feature flags, migration safety.
- **Suggested branch:** `feat/auth`
- **Completion criteria:** Plain `docker compose up` remains unauthenticated and compatible; enabled seeded mode passes its contract; health remains public; unknown bearer headers are ignored when auth is disabled.

## Current checkpoint

- Task 0.1 is merged to `main` at `f1a76ee`.
- Task 0.2 proposal commit: `cc049b210672352b6979d0c5472986863c8f0651`.
- The reviewer/architect accepted the Stage 0.2 architecture baseline and all 12 ADRs on `2026-08-08`.
- Architecture acceptance commit: `169f62bf82d4f5bca332885ed3e006422591e381`.
- Stage 0.2 was merged through [PR #2](https://github.com/AbdalrhemDado/log-stream/pull/2) in merge commit `056b16cacefa8f1f595d652865fb6c0269b72d90`; local `main` was updated.
- Stage 1 was merged through [PR #3](https://github.com/AbdalrhemDado/log-stream/pull/3) in merge commit `3f1960d8640ba77602f58d41d014ec65dff92695`; both approved Stage 1 commits are ancestors of `main`.
- Stage 2, Task 2.1 was committed and pushed on `feat/database-foundation` as `6b0672ad5ba4a5282d58698ab8090b795278a330`.
- Stage 2, Task 2.2 migration-runner implementation and validation are complete on the same branch; the Task 2.2 changes remain uncommitted and unpushed pending review.
- Task 2.3 has not started and requires separate explicit authorization.
