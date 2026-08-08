# ADR 0010 — Error Handling and Security Boundaries

- **Status:** `PROPOSED — NOT APPROVED`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Stages 1–7 after approval

## Context

The required API has precise client-error shapes, partial batch rejection semantics, and a disqualifying SQL-injection requirement. At the same time, client responses and logs must not expose database errors, credentials, stack traces, or unsafe attribute-object behavior.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Handle errors separately in every route | Local and initially direct | Inconsistent status/body rules, repeated redaction logic, and easy information leaks |
| Typed application errors with one HTTP mapper | Consistent contract and testable redaction boundary | Requires a small error taxonomy and disciplined translation |
| Expose framework/database errors in non-production mode | Fast local diagnosis | Risks mode-dependent contract drift and secret/internal leakage |

## Proposed decision

**PROPOSED — not approved:** define typed, internal application errors and map them through one HTTP error boundary. Validation/parser/cursor errors map to documented `400` responses; unexpected defects map to a generic `500`; temporary database unavailability maps to a generic `503` with `Retry-After` only when the failure is confidently classified as transient. Partial invalid log entries remain successful batch-domain results when at least one valid entry is durably committed; they are not exceptions.

All user-supplied SQL values use PostgreSQL parameters. Dynamic bucket, grouping, sort, and other structural fragments come only from exhaustive application-owned maps. No raw client value becomes an identifier, operator, or SQL fragment. Attribute keys and values remain parameters even when the storage operator is dynamic.

For arbitrary attribute keys, the implementation must avoid ordinary-object prototype mutation and inherited-property checks. **PROPOSED:** accept and preserve an empty ingestion key because the company contract establishes no key restriction; preserve non-empty Unicode keys exactly; and accept JavaScript-sensitive keys such as `__proto__` and `constructor` only through safe own-property/null-prototype or equivalent representations. Bare query name `attr.` remains separately invalid because the recognized `attr.<key>` grammar has no key segment. This remains subject to the attribute-storage/security approval and tests.

Cursor validation is not cursor authentication. The proposed unsigned cursor rejects malformed structures, invalid fields, versions, and filter mismatches, but a structurally valid timestamp/ID change is not cryptographically detectable and must be documented rather than mislabeled as tampering protection.

Ordinary request traffic uses a restricted non-superuser runtime role. A separate non-superuser owner role is used only for startup migrations/schema preparation; ongoing retention reaches owner-required partition operations through narrowly scoped, hardened routines. Role separation limits database blast radius but does not replace parameterization, query whitelists, input validation, credential redaction, or process/container security.

Logs use structured fields, redaction, bounded representations of untrusted input, and a generated request identifier. Stack traces and raw database errors stay internal. Default required endpoints remain unauthenticated; optional authentication is deferred.

## Consequences

### Positive

- Centralizes API-shape consistency and sensitive-data redaction.
- Makes injection protection reviewable at the data-access boundary.
- Preserves the company's arbitrary-key compatibility without accepting prototype hazards.
- Limits ordinary request connections to reviewed runtime privileges.

### Negative

- Transient versus permanent database errors can be difficult to classify safely.
- Safe arbitrary-key behavior requires focused parser, object, and persistence tests.
- Unsigned cursor positions remain modifiable, and privileged retention routines require careful ownership/`search_path` review.
- Central error mapping must not erase useful internal diagnostic context.

## Evidence and review gates

- Contract tests for every required client error and representative server failure.
- Injection payload suite for every string filter, cursor, aggregation enum, and attribute key/value.
- Tests for empty, Unicode, `__proto__`, `constructor`, and inherited-looking attribute keys.
- Cursor tests distinguish malformed/invalid/filter-mismatched input from structurally valid changed positions.
- Privilege tests prove request traffic is non-superuser/runtime-only, unrelated DDL is denied, and approved retention operations remain available.
- Response/log inspection proving the absence of stacks, SQL text with values, credentials, and raw database errors.
- Fault injection for unavailable database, failed commit, and unexpected application exceptions.

## References

- Requirements: `INF-001`, `HLT-002`, `CORE-002`, `SEC-001`, `SEC-002`, `SEC-003`, `ING-006`–`ING-008`, `ING-010`–`ING-013`, `QRY-005`, `QRY-015`, `AGG-008`, `OPT-002`
- Edge cases: `EDGE-ATTR-007`, `EDGE-ATTR-008`, `EDGE-BAT-005`, `EDGE-BAT-007`–`EDGE-BAT-009`, `EDGE-QRY-004`, `EDGE-QRY-009`, `EDGE-QRY-019`, `EDGE-CUR-001`, `EDGE-CUR-004`–`EDGE-CUR-006`, `EDGE-AGG-002`, `EDGE-AGG-003`
- Project decision: `DEC-012`
- Training: Learn TypeScript; Learn HTTP Servers in TypeScript; Learn HTTP Clients in TypeScript; Learn SQL; Build a Blog Aggregator in TypeScript

## Approval questions

1. Approve the typed-error and centralized HTTP-mapping boundary?
2. Approve cautious `503` plus `Retry-After` for confidently transient database failures, with `500` as the generic fallback?
3. Approve accepting empty ingestion keys while keeping bare query name `attr.` invalid, plus prototype-safe preservation for all keys?
4. Approve separate migration-owner/runtime roles with hardened narrow retention routines?
