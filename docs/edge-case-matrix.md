# Edge-Case Matrix

## Purpose

This matrix separates the authoritative company contract from behavior chosen by the project. It must be consulted before writing validators, HTTP handlers, persistence code, or contract tests.

## Classification rules

| Classification | Meaning |
|---|---|
| `SPECIFIED` | Directly required by `docs/company-requirements.md`. |
| `DERIVED` | Logically necessary to implement or preserve an explicit company requirement. |
| `DESIGN DECISION` | The company specification is silent; the project chooses or must choose the behavior. |
| `DEFERRED` | Resolution requires Stage 0.2 architecture work or later performance evidence. |

“Company specification” states only what the company says. “Project position” records our interpretation or decision. A project decision must never be presented as a company requirement.

## Ingestion request shape and fields

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-ING-001 | Missing `logs` property | SPECIFIED | A request that does not match the expected top-level structure returns `400`. | Reject with `400`. | Settled; top-level contract test. |
| EDGE-ING-002 | `logs` is `null`, an object, or another non-array value | SPECIFIED | `POST /logs` always accepts a batch represented by a `logs` array. | Reject with `400`. | Settled; top-level contract tests. |
| EDGE-ING-003 | Bare log object without `{ "logs": [...] }` | SPECIFIED | The required endpoint always accepts a batch; a one-entry batch is valid. | Reject as an invalid top-level structure. | Settled; contract test. |
| EDGE-ING-004 | Empty `logs` array | DESIGN DECISION | The specification does not define an empty batch. | The shape is valid, but no entry is accepted; return `400` with zero accepted entries. | Project decision; contract test. |
| EDGE-ING-005 | Non-object item in the `logs` array | DERIVED | Every entry must contain the documented required fields. | Reject that entry independently; continue processing valid entries. | Settled; mixed-batch test. |
| EDGE-ING-006 | Unknown top-level JSON fields | DESIGN DECISION | The specification requires `logs` but does not prohibit extra top-level properties. | Accept and ignore harmless extra fields. Validate and process only `logs`. | Project decision; compatibility test. |
| EDGE-ING-007 | Unknown fields inside a log entry | DESIGN DECISION | The specification defines required and optional fields but does not prohibit additional properties. | Accept and ignore extra entry fields; do not persist or echo them. | Project decision; compatibility and persistence tests. |
| EDGE-ING-008 | Unknown field contains a large or complex value | DESIGN DECISION | The specification does not define unknown-field handling. | Ignore semantically, while normal HTTP body/resource protections still apply to the complete request. | Project decision; resource policy deferred where limits are involved. |
| EDGE-ING-009 | Duplicate JSON object keys | DESIGN DECISION | The specification is silent, and JSON parser behavior may decide which value survives. | Document and test the selected framework/parser behavior if duplicate keys can be observed. | Open until framework selection. |

## Required strings and timestamp validation

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-VAL-001 | Missing service or message | SPECIFIED | Both fields are required. | Reject the entry. | Settled; validator tests. |
| EDGE-VAL-002 | Service or message has the wrong JSON type | SPECIFIED | Both fields must be strings. | Reject the entry. | Settled; validator tests. |
| EDGE-VAL-003 | Service or message is `""` | SPECIFIED | Both fields must be non-empty strings. | Reject the entry. | Settled; validator tests. |
| EDGE-VAL-004 | Service or message is whitespace only | DESIGN DECISION | “Non-empty” is not defined as “non-empty after trimming.” | Use literal non-empty validation: accept a string whose length is greater than zero and do not trim it implicitly. | Project decision; unit and contract tests. |
| EDGE-VAL-005 | Leading or trailing whitespace around meaningful content | DESIGN DECISION | The specification does not require normalization. | Preserve the supplied string exactly. | Project decision; round-trip test. |
| EDGE-VAL-006 | Empty level or differently-cased level | SPECIFIED | Level must be exactly one of `debug`, `info`, `warn`, or `error`. | Reject it; do not normalize case. | Settled; validator tests. |
| EDGE-VAL-007 | Invalid calendar date or otherwise invalid timestamp | SPECIFIED | Timestamp must be valid ISO 8601. | Reject the entry. | Settled; validator tests. |
| EDGE-VAL-008 | ISO 8601 offset and fractional-second variants | DESIGN DECISION | The specification says valid ISO 8601 but does not state the accepted grammar profile. | Define a documented timestamp profile before implementing the validator. | Open; validator compatibility decision. |
| EDGE-VAL-009 | Date-only or time without an explicit offset | DESIGN DECISION | “Timestamp” and “ISO 8601” do not clarify whether an unambiguous instant is required. | Decide and document the accepted profile; do not rely on permissive JavaScript parsing accidentally. | Open; validator compatibility decision. |
| EDGE-VAL-010 | Timestamp exactly five minutes in the future | DERIVED | A timestamp must not be more than five minutes in the future. | Accept the exact boundary; reject only values beyond it. | Settled; boundary test. |
| EDGE-VAL-011 | Time advances while one batch is being validated | DERIVED | Every entry is subject to the same five-minute rule. | Capture the request reference time once so entries in one batch receive consistent treatment. | Settled; pure-validator test. |
| EDGE-VAL-012 | Very old but otherwise valid timestamp | DESIGN DECISION | Ingestion has a future bound but no explicit lower age bound. | Keep ingestion-age behavior open until retention semantics are approved. | Open; linked to EDGE-RET-001. |

## Attributes

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-ATTR-001 | `attributes` omitted on ingestion | SPECIFIED | `attributes` is optional. | Accept the entry. | Settled; ingestion test. |
| EDGE-ATTR-002 | Empty attributes object | DERIVED | A flat object with permitted values is valid; an empty object has no invalid values. | Accept it. | Settled; validator test. |
| EDGE-ATTR-003 | String, number, or boolean value | SPECIFIED | These are the permitted attribute value types. | Accept and preserve the original JSON type. | Settled; round-trip tests. |
| EDGE-ATTR-004 | Nested object or array value | SPECIFIED | Nested objects and arrays are not allowed. | Reject the affected entry. | Settled; validator tests. |
| EDGE-ATTR-005 | Null attribute value | DERIVED | Permitted values are limited to strings, numbers, and booleans. | Reject the affected entry. | Settled; validator test. |
| EDGE-ATTR-006 | `attributes` is an array, primitive, or `null` | SPECIFIED | When present, attributes must be a flat object. | Reject the affected entry. | Settled; validator tests. |
| EDGE-ATTR-007 | Empty attribute key on ingestion | DESIGN DECISION | The specification permits arbitrary keys but does not define whether an empty key is valid. | Decide before validator implementation. | Open; compatibility/security review. |
| EDGE-ATTR-008 | Special keys such as `__proto__` or `constructor` | DESIGN DECISION | The specification permits arbitrary keys but does not discuss language-specific object hazards. | Preserve contract compatibility only with a representation that cannot mutate application prototypes or query structure. | Open until implementation design; security tests required. |
| EDGE-ATTR-009 | Numeric spellings and string comparison | DERIVED | Query attribute equality is compared as strings while response values retain their JSON types. | Define deterministic string conversion when the storage/query ADR is approved. | Deferred representation; cross-type tests required. |
| EDGE-ATTR-010 | Log ingested without attributes is queried | DERIVED | The required query response includes an `attributes` field, while ingestion makes it optional. | Always return `"attributes": {}` rather than omitting the field. This preserves a stable response shape and represents no supplied attributes. | Settled compatibility decision; contract test. |
| EDGE-ATTR-011 | Maximum attribute count, key length, or value length | DEFERRED | The specification sets no explicit size limits and requires load-generator compatibility. | Establish only evidence-based safety limits; do not add a small undocumented cap. | Deferred to performance/security validation. |
| EDGE-ATTR-012 | Attribute storage and search representation | DEFERRED | Arbitrary attributes and string-comparison queries are required; physical design is intentionally open. | Compare alternatives in Stage 0.2; no selection in Task 0.1. | Deferred ADR. |

## Batch processing and failures

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-BAT-001 | All entries valid | SPECIFIED | Return `200` when at least one entry is accepted. | Persist all entries durably, then return the documented response. | Settled; contract and row-count tests. |
| EDGE-BAT-002 | Mixed valid and invalid entries | SPECIFIED | Invalid entries must not reject valid entries. | Persist valid entries and return every rejected original index/reason. | Settled; mixed-batch test. |
| EDGE-BAT-003 | All entries invalid | SPECIFIED | Return `400`. | Return zero accepted and all rejection details. | Settled except exact top-level response wording; contract test. |
| EDGE-BAT-004 | Rejected entries appear out of order internally | DESIGN DECISION | The specification requires original indexes but not rejection-array ordering. | Return rejections in ascending original-index order for predictability. | Project decision; response-order test. |
| EDGE-BAT-005 | Exact rejection reason wording | DESIGN DECISION | Reasons must be useful, but exact text is not prescribed. | Use stable, field-specific reasons without stack traces or internal details. | Open vocabulary; table-driven tests. |
| EDGE-BAT-006 | Malformed JSON | SPECIFIED | Return `400`. | Do not treat parser failure as an entry-level rejection. | Settled; raw malformed-body contract test. |
| EDGE-BAT-007 | Database failure after successful validation | SPECIFIED | Never return `200` for data that was not durably accepted. | Return a safe server failure; do not report accepted success. | Durability settled; exact status/body open. |
| EDGE-BAT-008 | Failure after some internal chunks execute | DERIVED | Accepted success must represent durable acceptance. | Transaction/commit behavior must prevent a false accepted count or undocumented partial commit. | Mechanism deferred; failure integration test. |
| EDGE-BAT-009 | Exact database-failure status and body | DESIGN DECISION | The specification does not prescribe this failure response. | Select safe `500`/`503` semantics in the error architecture; never expose raw database errors. | Open until Stage 1/2 design. |
| EDGE-BAT-010 | Very large valid batch | DEFERRED | No batch maximum is specified; a small hidden limit may break the load generator. | Measure memory, body parsing, insertion, and transaction behavior before setting/documenting a safety policy. | Deferred benchmark and contract evidence. |
| EDGE-BAT-011 | Client disconnects while a commit is in progress | DESIGN DECISION | The specification is silent; durability still governs any success claim. | Define cancellation/commit semantics with the server and database lifecycle design. | Open until architecture implementation. |

## Query parsing and filtering

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-QRY-001 | No query parameters | SPECIFIED | All `GET /logs` parameters are optional. | Return the newest page using default limit `100`. | Settled; contract test. |
| EDGE-QRY-002 | Unknown unrelated query parameter | DESIGN DECISION | The specification lists supported parameters but does not explicitly reject all unknown names. | Ignore unrelated unknown parameters for compatibility. | Project decision; compatibility test. |
| EDGE-QRY-003 | Misspelled supported parameter | DESIGN DECISION | The specification does not define typo handling. | It is an unknown parameter and is ignored; document that clients must use exact names. | Consequence of EDGE-QRY-002; compatibility test. |
| EDGE-QRY-004 | Malformed `attr.` with no key | DERIVED | Supported syntax is `attr.<key>`. | Reject with `400` because it claims a recognized namespace without supplying the required key. | Settled; parser test. |
| EDGE-QRY-005 | Multiple distinct `attr.<key>` parameters | DERIVED | Filters are freely combinable. | Combine distinct attribute filters with logical `AND`. | Settled; integration test. |
| EDGE-QRY-006 | Repeated same attribute key | DESIGN DECISION | The specification does not define duplicate-filter semantics. | Decide whether to reject or define explicit `AND` semantics. | Open; parser/compatibility review. |
| EDGE-QRY-007 | Duplicate scalar parameter such as two `service` values | DESIGN DECISION | The specification describes scalar parameters but not duplicates. | Decide whether to reject or choose a documented value. | Open; HTTP parser behavior review. |
| EDGE-QRY-008 | Empty `q` | DESIGN DECISION | The specification defines substring matching but not an empty search. | Decide between a no-op filter and `400`; do not let database behavior decide accidentally. | Open; contract decision. |
| EDGE-QRY-009 | `%`, `_`, or escape characters in `q` | DERIVED | `q` is a substring value, not a user-provided SQL pattern. | Treat these characters literally. | Settled; query-builder and injection tests. |
| EDGE-QRY-010 | Case variants in `q` | SPECIFIED | `q` is case-insensitive. | Match independent of letter case under documented database semantics. | Settled; integration tests. |
| EDGE-QRY-011 | Case variants in service, level, attribute key, or value | SPECIFIED | Service/level are exact matches; attributes compare as strings. Only `q` is declared case-insensitive. | Do not add case-folding to other filters. | Settled; integration tests. |
| EDGE-QRY-012 | Missing `limit` | SPECIFIED | Default is `100`. | Use `100`. | Settled; contract test. |
| EDGE-QRY-013 | `limit` over `1000`, non-numeric, or otherwise invalid | SPECIFIED | Maximum is `1000`; invalid/non-numeric/out-of-range values return `400`. | Parse strictly and reject invalid input. | Settled except minimum; parser tests. |
| EDGE-QRY-014 | `limit=0` or negative limit | DESIGN DECISION | The company gives a default and maximum but no explicit minimum. | Project prompt proposes minimum `1`; record approval before implementation. | Open; contract decision. |
| EDGE-QRY-015 | Partial numeric limit such as `10abc` | DERIVED | A non-numeric limit is invalid. | Reject rather than partially parse. | Settled; parser test. |
| EDGE-QRY-016 | `until` before `since` | SPECIFIED | This range is invalid. | Return `400`. | Settled; parser test. |
| EDGE-QRY-017 | `since` equals `until` | DERIVED | The range is inclusive at `since`, exclusive at `until`, and only an earlier `until` is declared invalid. | Accept as an empty range. | Settled; integration test. |
| EDGE-QRY-018 | No rows match | DERIVED | The endpoint returns logs and a nullable cursor. | Return `{"logs":[],"next_cursor":null}`. | Settled; contract test. |
| EDGE-QRY-019 | SQL-injection text in any filter | SPECIFIED | SQL injection is disqualifying; security evaluation requires parameterized/safe queries. | Keep all user values as parameters and all dynamic fragments on trusted whitelists. | Settled requirement; regression suite. |
| EDGE-QRY-020 | Very long query values | DEFERRED | No explicit length limits are specified. | Establish only justified request/resource limits without changing required semantics. | Deferred performance/security evidence. |

## Cursor pagination

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-CUR-001 | Malformed cursor | SPECIFIED | Invalid or malformed cursors return `400` with the error response shape. | Reject safely without exposing internals. | Settled; contract tests. |
| EDGE-CUR-002 | Multiple logs share one timestamp | SPECIFIED | Ordering must remain deterministic when timestamps are equal. | Use an approved stable tie-breaker and matching keyset condition. | Requirement settled; ID/tie-breaker deferred. |
| EDGE-CUR-003 | Final page | SPECIFIED | `next_cursor` is `null` when no additional results exist. | Return `null`, including exact-limit final pages. | Settled; pagination tests. |
| EDGE-CUR-004 | Cursor reused with different filters | DEFERRED | Cursor format is implementation-defined. | Decide binding/validation rules with the Stage 0.2 cursor design. | Deferred architecture decision. |
| EDGE-CUR-005 | Cursor tampering | DEFERRED | Malformed cursors are invalid, but integrity mechanism is not specified. | Select validation/integrity behavior in Stage 0.2. | Deferred architecture/security analysis. |
| EDGE-CUR-006 | Rows inserted between pages | DESIGN DECISION | The specification requires cursor pagination and deterministic order but no snapshot guarantee. | Define and document continuation semantics; do not claim snapshot isolation unless implemented. | Open; integration tests after cursor design. |
| EDGE-CUR-007 | Rows deleted by retention between pages | DESIGN DECISION | The specification does not define this interaction. | Define best-effort continuation semantics and document limitations. | Open; cursor/retention integration test. |
| EDGE-CUR-008 | ID, tie-breaker, and cursor encoding | DEFERRED | IDs must be unique and cursors opaque; formats are implementation-defined. | Evaluate in Stage 0.2 without selecting a format here. | Deferred ADR. |

## Aggregation

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-AGG-001 | Missing `since`, `until`, or `bucket` | SPECIFIED | All three are required. | Return `400` with the standard error shape. | Settled; contract tests. |
| EDGE-AGG-002 | Unsupported bucket | SPECIFIED | Only `1m`, `5m`, `1h`, and `1d` are supported. | Return `400`; never turn the value into arbitrary SQL. | Settled; whitelist tests. |
| EDGE-AGG-003 | Unsupported `group_by` | SPECIFIED | Only `service` and `level` are supported. | Return `400`; never turn the value into arbitrary SQL. | Settled; whitelist tests. |
| EDGE-AGG-004 | Equal range bounds | DERIVED | Range bounds retain inclusive/exclusive semantics, and only earlier `until` is explicitly invalid. | Accept and return an empty `buckets` array. | Settled; contract test. |
| EDGE-AGG-005 | Empty time buckets | SPECIFIED | Empty buckets may be omitted. | Omit them rather than synthesizing zero rows unless later requirements change. | Settled; integration test. |
| EDGE-AGG-006 | No grouping | SPECIFIED | `group` must be `null`. | Include the field with JSON null on every result row. | Settled; response-shape test. |
| EDGE-AGG-007 | Multiple groups have the same bucket start | DESIGN DECISION | Only bucket-start ascending order is required. | Decide whether to add a deterministic secondary group order. | Open; deterministic-output review. |
| EDGE-AGG-008 | Count exceeds JavaScript safe integer | DESIGN DECISION | Response requires a numeric `count`, but extreme counts and serialization are not discussed. | Define safe conversion/error behavior before result mapping. | Open; type and integration tests. |
| EDGE-AGG-009 | Bucket timezone and anchor behavior | DEFERRED | Bucket sizes and range semantics are specified; the database bucketing implementation is not. | Decide with the Stage 0.2 database design and test boundary instants. | Deferred ADR/integration evidence. |

## Retention and lifecycle

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-RET-001 | Ingested timestamp is already older than the configured retention window | DESIGN DECISION | Ingestion sets no lower timestamp bound; retention must remove expired data. | Decide whether to accept then promptly expire or reject under documented policy. | Open for Stage 0.2 retention analysis. |
| EDGE-RET-002 | Timestamp exactly at retention cutoff | DESIGN DECISION | The specification requires configurable expiry but does not define cutoff inclusivity. | Define one precise comparison and test both sides of the boundary. | Open for Stage 0.2. |
| EDGE-RET-003 | Cleanup overlaps ingestion/querying | SPECIFIED | Retention is evaluated on avoiding major ingestion disruption, long locks, and excessive bloat. | Validate the selected design under concurrent traffic. | Requirement settled; mechanism/performance deferred. |
| EDGE-RET-004 | Multiple application instances run cleanup | DEFERRED | Safe concurrent startup/cleanup is evaluated, but the mechanism is open. | Select coordination behavior during Stage 0.2 architecture. | Deferred ADR and concurrency tests. |
| EDGE-RET-005 | Cleanup fails | DERIVED | Reliability and retention remain required; failure must not become silent data loss or an application crash. | Define observable failure/retry behavior with the retention architecture. | Deferred mechanism; failure tests required. |
| EDGE-RET-006 | Partitioning versus bounded deletion | DEFERRED | The company specifies outcomes, not storage/cleanup mechanics. | Compare alternatives in Stage 0.2 and later validate under load. | Deferred ADR and benchmark. |

## Optional features and default compatibility

| ID | Case | Classification | Company specification | Project position | Status / expected evidence |
|---|---|---|---|---|---|
| EDGE-OPT-001 | Default startup has no auth configuration | SPECIFIED | Required endpoints accept unauthenticated requests in zero-configuration mode. | Keep the core open by default. | Settled; default contract smoke test. |
| EDGE-OPT-002 | Unknown bearer header while auth is disabled | SPECIFIED | An unrecognized authorization header must be ignored when auth is disabled. | Process the request as ordinary unauthenticated core traffic. | Conditional test if auth code exists. |
| EDGE-OPT-003 | Health request while auth is enabled | SPECIFIED | Health is always unauthenticated. | Never require credentials on health. | Conditional auth contract test. |
| EDGE-OPT-004 | Auth enabled without a load-generator key | SPECIFIED | The service still starts and remains healthy; no key is seeded. | Preserve readiness while data endpoints enforce configured auth. | Conditional startup test. |
| EDGE-OPT-005 | Optional rate limit affects the load generator | SPECIFIED | Rate limiting must be off by default or exempt the seeded load-generator key. | Optional limiting cannot reduce default compatibility. | Conditional contract/load test. |

## Architecture and performance decisions deliberately deferred

The following are not resolved by this matrix and must not be inferred from examples in the project prompt:

- JSONB and attribute storage design;
- index selection;
- partitioning strategy;
- retention mechanism;
- UUID or other ID/tie-breaker choice;
- cursor encoding and integrity design;
- `COPY` versus `UNNEST` or another bulk-ingestion method;
- migration tooling;
- framework-specific architecture;
- safe maximum batch/body/query sizes;
- database pool, concurrency, and backpressure thresholds.

Each requires an approved ADR or measured evidence in its scheduled task.
