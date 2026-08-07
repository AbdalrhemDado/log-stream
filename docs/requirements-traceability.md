# Requirements Traceability Matrix

## Purpose

This matrix maps the authoritative company specification to future implementation, automated evidence, and documentation. It is the requirements baseline for the project; it is not an architecture decision record.

The authoritative source is [`company-requirements.md`](./company-requirements.md). `CODEX_PROJECT_PROMPT.md` supplies workflow guidance and candidate interpretations, but it cannot strengthen, weaken, or replace a company requirement.

## Authority and state

| Value | Meaning |
|---|---|
| `COMPANY` | Directly required by the company specification. |
| `DERIVED` | Logically necessary to implement or preserve an explicit company requirement. |
| `PROJECT DECISION` | The company specification is silent; this project selects or must select a behavior. |

Verification states progress only when supported by evidence:

`PLANNED` → `IMPLEMENTED` → `TESTED` → `VERIFIED UNDER LOAD`

Passing functional tests does not qualify a performance requirement as `VERIFIED UNDER LOAD`. Architecture-dependent implementation locations remain undecided until Stage 0, Task 0.2.

## Core system and infrastructure

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| CORE-001 | What You Are Building; Core Requirements | Ingest, store, query, aggregate, and retain structured logs. | Functional | COMPANY | Modules and data flows selected after architecture approval. | End-to-end contract and retention suites. | README architecture and API sections. | PLANNED | Architecture is deferred to Stage 0.2. |
| CORE-002 | Resource Limits | PostgreSQL remains the source of truth for reads and writes, even if additional infrastructure is used. | Architecture constraint | COMPANY | Persistence boundary backed by PostgreSQL; exact design deferred. | Integration tests verify committed PostgreSQL rows and query results. | README architecture and storage sections. | PLANNED | Whether any additional infrastructure is justified. |
| INF-001 | Core Requirements; Default Posture | A fresh default system starts with only `docker compose up`, without an environment file, arguments, or manual setup. | Compatibility | COMPANY | Compose and startup lifecycle; tooling choices deferred. | Fresh-clone Docker contract test. | README setup section. | PLANNED | None. |
| INF-002 | Required API Contract | The application listens on container port `8080` and is exposed at `localhost:8080`. | Compatibility | COMPANY | Server and Compose configuration. | Docker smoke test connects to `localhost:8080`. | README setup and API base URL. | PLANNED | None. |
| INF-003 | Resource Limits | The application operates within 0.5 CPU and 256 MB RAM; PostgreSQL operates within 1 CPU and 1 GB RAM. | Non-functional | COMPANY | Compose/load-test resource controls; tuning deferred. | Load run records configured limits and observed resource usage. | Performance report and README. | PLANNED | Exact Compose syntax and local enforcement method. |
| HLT-001 | `GET /health` | `GET /health` returns `200` only when the service is ready to accept traffic. | Compatibility, reliability | COMPANY | Readiness state in the startup lifecycle; framework deferred. | Startup polling and pre-readiness contract tests. | README health endpoint. | PLANNED | Non-ready response status/body is not specified. |
| HLT-002 | `GET /health` | Readiness requires an established database connection and applied migrations. | Reliability | COMPANY | Startup/migration coordination; tooling deferred. | Database-unavailable and failed-migration integration tests. | README startup lifecycle. | PLANNED | Migration design is deferred to Stage 0.2. |
| HLT-003 | Optional Features: Exemptions | `GET /health` remains unauthenticated when optional authentication is enabled. | Conditional compatibility | COMPANY | Authentication bypass for health if auth is implemented. | Auth-enabled contract smoke test. | Optional-features README section. | PLANNED | Applies only if authentication is implemented. |

## Log ingestion

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| ING-001 | `POST /logs` — Request | `POST /logs` accepts the documented top-level batch object containing a `logs` array. | Compatibility | COMPANY | Request parsing and top-level validation; framework deferred. | Contract tests for valid and invalid top-level bodies. | README ingestion API. | PLANNED | Empty-array behavior is project decision DEC-001. |
| ING-002 | `POST /logs` — Ingest Logs | A one-entry batch is valid. | Functional | COMPANY | Same batch path for one or many entries. | One-entry contract test. | README ingestion examples. | PLANNED | None. |
| ING-003 | Validation Rules | Every entry requires a valid ISO 8601 timestamp no more than five minutes in the future. | Functional | COMPANY | Runtime entry validator. | Table-driven timestamp tests with a captured request time. | README validation table. | PLANNED | Exact accepted ISO 8601 grammar is DEC-006. |
| ING-004 | Validation Rules | Every entry requires a level exactly equal to `debug`, `info`, `warn`, or `error`. | Functional | COMPANY | Runtime validator and an appropriate persistence invariant after schema approval. | Unit and database integration tests. | README validation table. | PLANNED | None. |
| ING-005 | Validation Rules | Every entry requires `service` and `message` to be non-empty strings. | Functional | COMPANY | Runtime validator; persistence constraints deferred. | Empty, wrong-type, and valid-string tests. | README validation table. | PLANNED | Whitespace behavior is DEC-004. |
| ING-006 | Validation Rules | `attributes` is optional and, when present, is a flat object whose values are strings, numbers, or booleans. | Functional | COMPANY | Runtime validator; storage representation deferred. | Attribute type and shape unit tests. | README validation table and attribute strategy. | PLANNED | Storage design is deferred to Stage 0.2. |
| ING-007 | Validation Rules | Nested objects and arrays are invalid attribute values. | Functional | COMPANY | Runtime validator. | Nested-object and array rejection tests. | README validation table. | PLANNED | None. |
| ING-008 | Validation Rules | Null and other non-permitted attribute values are invalid. | Functional | DERIVED | Runtime validator. | Null-value rejection test. | README validation table. | PLANNED | None. |
| ING-009 | Batch Behavior | Validate entries independently so an invalid entry does not reject valid entries in the same batch. | Functional, reliability | COMPANY | Validation partitions the batch before persistence. | Mixed-batch unit, integration, and contract tests. | README partial-acceptance behavior. | PLANNED | Database transaction boundary is deferred to architecture. |
| ING-010 | Batch Behavior | Report the original array index and a useful reason for every rejected entry. | Compatibility | COMPANY | Rejection model retains input index. | Mixed-batch response assertions. | README response schema. | PLANNED | Exact reason vocabulary and ordering are project decisions. |
| ING-011 | Response | Return `200` when at least one entry is accepted. | Compatibility | COMPANY | Route response mapping. | Mixed and all-valid contract tests. | README status-code table. | PLANNED | None. |
| ING-012 | Response | Return `400` when all entries are rejected, JSON is malformed, or the top-level structure is invalid. | Compatibility | COMPANY | Parse/validation error mapping. | Negative contract tests for each case. | README status-code table. | PLANNED | Error body for malformed/top-level failures is not specified. |
| ING-013 | Rate Limiting and Backpressure | Never return `200` for a batch that has not been durably accepted. | Reliability, durability | COMPANY | Persistence success is acknowledged only after PostgreSQL commit; mechanism deferred. | Database-failure and committed-row-count integration tests. | README ingestion data flow and failure behavior. | PLANNED | Failure status/body is DEC-016. |
| ING-014 | Required API Contract | Harmless unknown top-level fields are accepted and ignored. | Compatibility | PROJECT DECISION | Validate and use only the documented `logs` property. | Contract test with extra top-level metadata. | Edge-case matrix and README compatibility notes. | PLANNED | Revisit only if load-generator evidence conflicts. |
| ING-015 | Validation Rules | Harmless unknown fields inside a valid entry are accepted and ignored. | Compatibility | PROJECT DECISION | Validate, persist, and return only documented fields. | Contract test with an extra entry property. | Edge-case matrix and README compatibility notes. | PLANNED | Unknown fields must never flow into SQL or storage. |

## Log querying and pagination

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| QRY-001 | `GET /logs` | `GET /logs` supports optional, freely combinable documented filters. | Functional | COMPANY | Typed filter parsing and safe persistence query after architecture approval. | Unit combination matrix plus integration/contract tests. | README query API. | PLANNED | Duplicate parameter behavior is DEC-007/DEC-008. |
| QRY-002 | Query parameter table | `service` and `level` use exact matching; unsupported levels are invalid. | Functional | COMPANY | Validated filter model and parameterized predicates. | Exact-match and invalid-level tests. | README filter semantics. | PLANNED | Matching case sensitivity follows exact value equality. |
| QRY-003 | Query parameter table | `since` is inclusive and `until` is exclusive. | Functional | COMPANY | Validated range model and parameterized predicates. | Boundary-row integration tests. | README range semantics. | PLANNED | Equal bounds are covered by QRY-017. |
| QRY-004 | Invalid Parameters | `until` earlier than `since` is invalid. | Functional | COMPANY | Range validation. | Earlier-range rejection test. | README range semantics and edge-case matrix. | PLANNED | None. |
| QRY-005 | Query parameter table | Each `attr.<key>` filter compares attribute values as strings. | Functional | COMPANY | Attribute query behavior after storage ADR approval. | String/number/boolean equivalence integration tests. | README attribute strategy. | PLANNED | Storage and index representation are deferred. |
| QRY-006 | Core Requirements; `GET /logs` | Multiple distinct attribute filters can be combined with other filters. | Functional | DERIVED | Shared filter model; query design deferred. | Multi-attribute combination tests. | README filter semantics. | PLANNED | Repeated identical keys are DEC-008. |
| QRY-007 | Query parameter table | `q` performs a case-insensitive substring match on `message`. | Functional | COMPANY | Safe query predicate after architecture approval. | Case and substring integration tests. | README filter semantics. | PLANNED | Empty `q` is DEC-009. |
| QRY-008 | `q` semantics; Security evaluation | SQL wildcard characters in `q` are treated as literal substring characters. | Functional, security | DERIVED | Parameterized predicate with literal semantics; database expression deferred. | `%`, `_`, escape-character, and injection tests. | README filter semantics and security notes. | PLANNED | None. |
| QRY-009 | Query parameter table | `limit` defaults to `100` and cannot exceed `1000`. | Compatibility | COMPANY | Strict query parsing. | Default, valid, non-numeric, and over-maximum tests. | README query API. | PLANNED | Minimum limit is DEC-010. |
| QRY-010 | Sorting | Results are ordered by timestamp descending with deterministic ordering for equal timestamps. | Functional | COMPANY | Stable secondary ordering selected in Stage 0.2. | Identical-timestamp integration tests. | README pagination design. | PLANNED | ID/tie-breaker choice is deferred. |
| QRY-011 | Response | Every returned log has a unique string-compatible ID and the documented log fields. | Compatibility | COMPANY | Response mapping after ID and storage decisions. | Exact response-shape contract tests. | README response schema. | PLANNED | ID choice is deferred. |
| QRY-012 | Response; ingestion attributes optional | A returned log always includes `attributes`; a log ingested without attributes returns `"attributes": {}`. | Compatibility | DERIVED | Response mapper normalizes missing attributes to an empty object. | Contract test ingesting without attributes and querying it. | README response schema and edge-case matrix. | PLANNED | None. |
| QRY-013 | Response | `next_cursor` is opaque to clients and is `null` when no additional results exist. | Compatibility | COMPANY | Cursor construction selected in Stage 0.2. | Single-page, final-page, and multi-page contract tests. | README pagination design. | PLANNED | Encoding is deferred. |
| QRY-014 | Core Requirements; Response | Pagination is cursor-based. | Functional | COMPANY | Cursor behavior selected in Stage 0.2. | Multi-page contract tests. | README pagination semantics. | PLANNED | Cursor encoding is deferred. |
| QRY-015 | Invalid Parameters | Invalid timestamps, ranges, levels, limits, and cursors return `400` with `{"error":"<description>"}`. | Compatibility | COMPANY | Query parser and safe error mapping. | Negative contract suite. | README error table. | PLANNED | None. |
| QRY-016 | Required API Contract | Unrelated unknown query parameters are ignored; recognized parameters remain strictly validated. | Compatibility | PROJECT DECISION | Parser consumes only documented parameters and recognized `attr.<key>` names. | Contract test with harmless extra query metadata. | Edge-case matrix and README compatibility notes. | PLANNED | Malformed `attr.` remains invalid as a derived contract rule. |
| QRY-017 | Query parameter table; Invalid Parameters | Equal `since` and `until` bounds form an empty inclusive/exclusive range. | Functional | DERIVED | Range validation accepts equal bounds. | Equal-range empty-result test. | README range semantics and edge-case matrix. | PLANNED | None. |
| QRY-018 | Cursor-based pagination; deterministic sorting | Cursor pages do not skip or duplicate rows under the documented continuation semantics. | Functional | DERIVED | Matching keyset ordering and continuation behavior selected in Stage 0.2. | Multi-page tests including equal timestamps. | README pagination semantics. | PLANNED | Concurrent-insert semantics are DEC-014. |

## Aggregation

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| AGG-001 | `GET /logs/aggregate` | The aggregation endpoint requires valid inclusive `since`, exclusive `until`, and `bucket`. | Functional | COMPANY | Validated aggregation request model. | Missing, invalid, and boundary parameter tests. | README aggregation API. | PLANNED | Equal bounds follow QRY-017. |
| AGG-002 | Aggregation parameter table | `bucket` accepts exactly `1m`, `5m`, `1h`, or `1d`. | Compatibility, security | COMPANY | Hard-coded application whitelist; SQL expression deferred. | Test each valid bucket and invalid values. | README aggregation API. | PLANNED | Bucketing expression and timezone details require Stage 0.2. |
| AGG-003 | Aggregation parameter table | `group_by` is optional and accepts only `service` or `level`. | Compatibility, security | COMPANY | Hard-coded application whitelist; SQL expression deferred. | Grouped and invalid-value tests. | README aggregation API. | PLANNED | None. |
| AGG-004 | `GET /logs/aggregate` | Aggregation supports `service`, `level`, `attr.<key>`, and `q` with list-query semantics. | Functional | COMPANY | Shared validated filter behavior; architecture deferred. | Filter parity and combined-filter tests. | README aggregation filters. | PLANNED | None. |
| AGG-005 | Response | Return one row for each existing bucket/group combination; empty buckets may be omitted. | Functional | COMPANY | Aggregation result mapping. | Sparse-range integration tests. | README aggregation response. | PLANNED | None. |
| AGG-006 | Response | Order results by bucket start ascending. | Compatibility | COMPANY | Deterministic query/result ordering. | Order assertions across buckets. | README aggregation response. | PLANNED | Same-bucket group ordering is DEC-013. |
| AGG-007 | Response | When grouping is absent, every bucket has `group: null`. | Compatibility | COMPANY | Response mapper. | No-group contract test. | README response schema. | PLANNED | None. |
| AGG-008 | Invalid Parameters | Invalid aggregation parameters return `400` with `{"error":"<description>"}`. | Compatibility | COMPANY | Parser and error mapping. | Negative aggregation contract tests. | README error table. | PLANNED | None. |

## Retention, performance, security, and reliability

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| RET-001 | What You Are Building; Retention | Provide a configurable policy that removes expired logs. | Functional | COMPANY | Mechanism selected after Stage 0.2 analysis. | Cutoff, expired-removal, and recent-preservation tests. | README retention strategy and ADR. | PLANNED | Configuration and cleanup mechanism are deferred. |
| RET-002 | What We Are Evaluating: Retention | Retention avoids long-running locks, excessive bloat, and major ingestion disruption. | Non-functional | COMPANY | Design and measurement deferred. | Concurrent ingestion/cleanup tests and database observations. | ADR and performance report. | PLANNED | Partitioned versus non-partitioned cleanup is deferred. |
| RET-003 | Reliability evaluation | Retention boundary, concurrent execution, failure, and shutdown behavior are deliberate and observable. | Reliability | DERIVED | Lifecycle selected after architecture approval. | Boundary, concurrency, failure, and shutdown tests. | Retention ADR and operational notes. | PLANNED | Exact scheduling and locking approach are deferred. |
| SEC-001 | What We Are Evaluating: Security | SQL injection is prevented using parameterized user values and safe dynamic-query construction. | Security | COMPANY | Persistence/query boundary selected after architecture approval. | Injection payloads for every string input and SQL-builder unit tests. | README security section and ADRs. | PLANNED | None. |
| SEC-002 | Aggregation contract; Security evaluation | Dynamic bucket, group, and other SQL identifiers are selected only from trusted application whitelists. | Security | DERIVED | Hard-coded maps in the future query layer. | Invalid dynamic-value and injection regression tests. | README security section. | PLANNED | None. |
| SEC-003 | Reliability and authentication sections | Client errors do not expose stack traces, secrets, credentials, or raw database errors. | Security, reliability | DERIVED | Central error mapping/log redaction; framework deferred. | Error-response and log-inspection tests. | README error/security notes. | PLANNED | Exact internal logging policy is deferred. |
| REL-001 | Performance Targets; Batch Behavior | Accepted requests are not dropped, and the application does not crash during sustained ingestion. | Reliability | COMPANY | Backpressure and failure strategy selected after measurement. | Sustained-load error accounting and database count reconciliation. | Performance report. | PLANNED | Backpressure thresholds are deferred. |
| REL-002 | Rate Limiting and Backpressure | If load is shed, use `429` or `503` with `Retry-After`; shed logs do not count as ingested. | Conditional reliability | COMPANY | Only if backpressure is required; implementation deferred. | Overload behavior tests and load report accounting. | README limitations/performance sections. | PLANNED | Whether explicit shedding is needed requires load evidence. |
| PERF-001 | Performance Targets | Sustain at least 15,000 logs per second. | Performance | COMPANY | Ingestion design and tuning deferred. | Reproducible load test under required limits with row reconciliation. | Performance report and README. | PLANNED | Batch size and concurrency must be measured. |
| PERF-002 | Performance Targets | Primary aggregation latency is below one second at p95. | Performance | COMPANY | Aggregation/storage/index design deferred. | Latency percentiles during concurrent ingestion. | Performance report and README. | PLANNED | Exact primary aggregation query must be recorded. |
| PERF-003 | Performance Targets | Query performance remains acceptable while ingestion is active. | Performance | COMPANY | Evidence-driven design and tuning. | Concurrent ingestion/query benchmark. | Performance report. | PLANNED | “Acceptable” beyond the aggregation target must be defined transparently. |
| PERF-004 | Performance Targets | The service handles approximately 1,000,000 records representing roughly one month. | Performance | COMPANY | Data model deferred. | Seed/load run and PostgreSQL row-count verification. | Performance report. | PLANNED | Dataset distribution must be documented. |
| PERF-005 | Performance Targets | Newly ingested data is queryable within 20 seconds. | Performance | COMPANY | Read/write path selected after architecture approval. | Timed ingest-to-query visibility test. | Performance report. | PLANNED | Measurement method must be specified before the run. |
| PERF-006 | Performance Targets | Sustain one aggregation request per second during ingestion testing. | Performance | COMPANY | External load generator. | Concurrent load report. | Performance methodology. | PLANNED | None. |
| PERF-007 | Performance Targets; README requirements | Performance claims report environment, dataset, batch size, rates, latency percentiles, resource use, bottlenecks, and optimizations. | Evidence, documentation | COMPANY | Reproducible benchmark/report pipeline. | Machine-readable report plus command record. | README and performance report. | PLANNED | No results may be recorded before measurement. |

## Optional-feature compatibility

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| OPT-001 | Optional Features: Golden Rule | Optional features are additive and never remove, rename, reshape, or newly restrict required behavior. | Conditional compatibility | COMPANY | Feature review gate after the measured core is complete. | Plain-core contract regression suite. | README optional-features inventory. | PLANNED | Optional work is not selected yet. |
| OPT-002 | Default Posture | Default mode accepts unauthenticated requests on all required endpoints and applies no load-generator-breaking rate, quota, or tenancy restriction. | Compatibility | COMPANY | Default configuration; optional features deferred. | No-credential contract smoke test. | README zero-configuration confirmation. | PLANNED | None. |
| OPT-003 | Authentication: Configuration | If auth is implemented, `AUTH_ENABLED` defaults to `false`; optional `LOADGEN_API_KEY` seeding is idempotent and completes before readiness. | Conditional compatibility | COMPANY | Authentication is deferred until the core passes contract and load tests. | Auth-enabled startup/restart tests. | README optional-auth configuration. | PLANNED | Whether auth will be implemented. |
| OPT-004 | Credential Transport; Status Codes | If auth is implemented, bearer credentials work; missing/malformed credentials return `401`, insufficient scope `403`, and auth failures never masquerade as success. | Conditional compatibility | COMPANY | Deferred optional feature. | Auth contract suite. | README auth API. | PLANNED | Whether auth will be implemented. |
| OPT-005 | Authentication: Exemptions | With auth disabled, unrecognized authorization headers are ignored; health always remains public. | Conditional compatibility | COMPANY | Deferred optional feature. | Disabled-auth and public-health tests. | README auth defaults. | PLANNED | Whether auth will be implemented. |
| OPT-006 | Multi-Tenancy | If multi-tenancy is implemented, tenant identity is derived from credentials without changing required requests or responses. | Conditional compatibility | COMPANY | Deferred optional feature. | Tenant-isolation and core-contract tests. | README tenancy design. | PLANNED | Whether tenancy will be implemented. |
| OPT-007 | CI Requirement | If auth is implemented, CI tests both unauthenticated default mode and enabled seeded-key mode; otherwise only default mode is required. | Conditional delivery | COMPANY | CI design in Stage 10. | CI workflow runs appropriate smoke matrix. | README CI section. | PLANNED | Depends on optional feature selection. |

## Delivery and learning

| ID | Source section | Normalized requirement | Classification | Authority | Planned implementation | Expected automated evidence | Expected documentation evidence | State | Open questions |
|---|---|---|---|---|---|---|---|---|---|
| CI-001 | Deliverables: Passing CI | Provide a meaningful CI pipeline that builds, tests, and validates the project. | Delivery | COMPANY | CI workflow after test foundations exist. | Successful CI runs including Docker/contract smoke. | README CI section. | PLANNED | Exact CI job split is deferred. |
| DOC-001 | Core Requirements; Deliverables: README | README covers setup, API, schema/indexes, attributes, retention, measured performance, limitations, and optional-feature controls. | Delivery | COMPANY | Incremental documentation finalized in Stage 10. | Documentation checklist. | README itself. | PLANNED | Architecture/performance sections remain pending evidence. |
| DEL-001 | Deliverables: GitHub repository | Deliver a GitHub repository with clean, readable, incremental history. | Delivery | COMPANY | Short-lived branches and focused approved commits. | Git history review and passing branch checks. | CONTRIBUTING/README workflow. | PLANNED | Merge strategy requires user choice. |
| DEL-002 | Deliverables: Docker Compose | Deliver a working Docker Compose system that starts with `docker compose up`. | Delivery | COMPANY | Stage 2 infrastructure. | Fresh-start contract test. | README setup. | PLANNED | None. |
| DEL-003 | Deliverables: Demo | Be able to explain architecture, trade-offs, schema/indexes, query plans, code paths, and live debugging. | Delivery, learning | COMPANY | Demo and interview package after implementation. | Manual rehearsal checklist. | Demo script and code walkthrough. | PLANNED | Final content depends on measured implementation. |
| DEL-004 | Important Note | Submit an approximately five-minute video explaining architecture/key decisions and demonstrating the live system. | Delivery, learning | COMPANY | Stage 10 demo preparation. | Timed rehearsal. | Demo script. | PLANNED | Recording logistics are outside repository implementation. |

## Approved and open project decisions

These rows prevent project choices from being mistaken for company requirements.

| Decision ID | Topic | Authority | Current position | Status | Evidence needed |
|---|---|---|---|---|---|
| DEC-001 | Empty `logs` array | PROJECT DECISION | Treat as a valid batch shape with zero accepted entries and return `400`. | Approved for documentation | Contract test. |
| DEC-002 | Unknown top-level fields | PROJECT DECISION | Accept and ignore harmless extra fields. | Approved for documentation | Compatibility contract test. |
| DEC-003 | Unknown entry fields | PROJECT DECISION | Accept and ignore; do not persist or echo them. | Approved for documentation | Compatibility and persistence tests. |
| DEC-004 | Whitespace-only service/message | PROJECT DECISION | Apply literal non-empty validation; do not trim implicitly. | Approved for documentation | Unit and contract tests. |
| DEC-005 | Missing attributes in query response | DERIVED | Always return `attributes`; use `{}` when none were supplied. | Approved for documentation | Response-shape contract test. |
| DEC-006 | Exact accepted ISO 8601 grammar | PROJECT DECISION | Open. | Open | Compatibility examples and validator tests. |
| DEC-007 | Duplicate scalar query parameters | PROJECT DECISION | Open. | Open | HTTP parser behavior and compatibility review. |
| DEC-008 | Repeated identical attribute keys | PROJECT DECISION | Open. | Open | Semantics and client compatibility review. |
| DEC-009 | Empty `q` | PROJECT DECISION | Open. | Open | Semantics and contract test. |
| DEC-010 | Minimum `limit` | PROJECT DECISION | Project prompt proposes `1`; company gives only default and maximum. | Open | Compatibility review and contract test. |
| DEC-011 | Unknown query parameters | PROJECT DECISION | Ignore unrelated parameters; strictly validate recognized parameters and malformed `attr.` names. | Approved for documentation | Compatibility contract tests. |
| DEC-012 | Attribute-key validity and safety | PROJECT DECISION | Open: define safe handling for empty keys, unusual Unicode keys where relevant, and JavaScript-sensitive keys such as `__proto__` and `constructor` while preserving the company's arbitrary-key requirement. | Open | Stage 0.2 storage/security design, followed by validation and security tests. |
| DEC-013 | Group ordering within one bucket | PROJECT DECISION | Open; only bucket-start ordering is required. | Open | Determinism review. |
| DEC-014 | Pagination during concurrent inserts | PROJECT DECISION | Open; snapshot semantics are not required explicitly. | Open | Stage 0.2 cursor design and later integration tests. |
| DEC-015 | Ingesting logs older than retention | PROJECT DECISION | Open. | Open | Stage 0.2 retention policy analysis. |
| DEC-016 | Database-failure HTTP status/body | PROJECT DECISION | Open; it must never falsely report durable acceptance. | Open | Error architecture and failure contract tests. |

## Maintenance rule

When a task is completed, update only the rows it actually satisfies. Add links or exact paths to implementation and evidence at that time. Never advance a state based on an intended test, an unverified benchmark, or an architecture proposal.
