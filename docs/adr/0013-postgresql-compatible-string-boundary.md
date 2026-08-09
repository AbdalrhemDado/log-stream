# ADR 0013 — PostgreSQL-Compatible String Boundary

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-09`
- **Decision owner:** Reviewer and student checkpoint
- **Implementation stage:** Pre-Task-4.2 ingestion validation; query-parser enforcement deferred to Stage 5

## Context

The company contract requires non-empty `service` and `message` strings, permits string attribute values and arbitrary attribute keys, requires independent per-entry batch validation, and requires PostgreSQL to remain the durable source of truth. It does not define the complete Unicode character repertoire accepted by string fields and does not mention Unicode NUL, U+0000.

JSON permits an escaped U+0000 inside a string. `JSON.parse` converts that escape to an actual NUL code unit. Before this decision, the application validator accepted U+0000 in `service`, `message`, attribute keys, and string attribute values, and the attribute normalizer preserved it unchanged.

The selected storage design binds `service` and `message` through PostgreSQL `text[]` parameters and serializes original/search attributes through `jsonb[]` parameters. PostgreSQL cannot represent U+0000 in those types. One incompatible entry could therefore enter the accepted repository set, fail the set-based insert, and roll back otherwise valid records in the same transaction. Redacting the database error prevents information disclosure but does not restore predictable partial-batch behavior.

## Authority classification

| Classification | Statement |
|---|---|
| `COMPANY REQUIREMENT` | Service and message are non-empty strings; attribute values may be strings, numbers, or booleans; entries in a batch are validated independently; accepted data is durable in PostgreSQL. |
| `DERIVED REQUIREMENT` | Inputs classified as accepted must be representable by the selected durable storage path, or the project must provide a reversible representation that preserves the required API semantics. |
| `PROJECT DESIGN DECISION` | Reject U+0000 at application boundaries rather than encode it or redesign storage. |
| `IMPLEMENTATION CONSTRAINT` | PostgreSQL `text` and `jsonb` in the selected PostgreSQL 16 design cannot represent U+0000. |
| `TEST EVIDENCE` | Application validation probes and disposable PostgreSQL compatibility probes reproduce the boundary. |

The U+0000 restriction is a PostgreSQL-driven project limitation. It is not a company requirement.

## PostgreSQL 16.14 compatibility evidence

A disposable `postgres:16.14-bookworm` compatibility probe produced:

| Bound value | Observed SQLSTATE |
|---|---:|
| `text` containing U+0000 | `22021` |
| JSONB string value containing U+0000 | `22P05` |
| JSONB object key containing U+0000 | `22P05` |

The probe used no persistent volume and was removed afterward. These results establish compatibility behavior only; they are not a performance benchmark or evidence for any throughput, latency, freshness, memory, or resource target.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| A. Reject U+0000 before persistence | Deterministic per-entry behavior; no schema or repository change; low validation cost; existing query/index design remains visible | Adds a project-owned input restriction that the company did not explicitly state |
| B. Reversible application-level encoding | Could preserve U+0000 round trips without changing column types | Requires an injective collision-safe codec, prefix/version handling, response decoding, migration, storage expansion, and proof for exact equality and literal case-insensitive substring semantics |
| C. Storage/schema redesign | Could preserve a wider JavaScript string repertoire using binary or application-owned serialized forms | Replaces ordinary text/JSONB operators and indexes; complicates service grouping, attribute containment, `q`, aggregation, migrations, performance, and trainee explainability |
| D. Split or retry after database failure | Avoids an up-front repertoire decision | Uses PostgreSQL errors as runtime validation, repeats database work for unpersistable data, destabilizes rejection reasons, increases latency/availability risk, and leaves query-side U+0000 unresolved |

## Accepted decision

**ACCEPTED — 2026-08-09:** the company specification does not define the complete Unicode character repertoire accepted by string fields. PostgreSQL `text` and `jsonb` in the selected storage design cannot represent U+0000. The application therefore rejects an ingestion entry when `service`, `message`, an attribute key, or a string attribute value contains the U+0000 code unit.

This is a project design decision and storage limitation, not a company requirement. Rejection occurs during independent per-entry validation before persistence. Rejection reasons identify the affected field category without sanitizing, replacing, encoding, normalizing, or echoing the offending content.

The stable ingestion rejection reasons are:

```text
service must not contain U+0000
message must not contain U+0000
attribute keys must not contain U+0000
string attribute values must not contain U+0000
```

Validation retains the existing field order:

1. `service`: required, string type, non-empty, then U+0000 compatibility;
2. `message`: required, string type, non-empty, then U+0000 compatibility;
3. `attributes`: container validity first; for each own enumerable entry, key compatibility, permitted value type, then string-value compatibility.

Only accepted keys and values are copied into the existing null-prototype result. Unknown entry fields remain ignored and are not scanned.

Future recognized PostgreSQL-bound query filters for `service`, `q`, attribute keys, and attribute values will apply the same U+0000 rule before SQL in Stage 5. This ADR does not authorize or implement query parsing.

The rule is specifically the presence of the U+0000 code unit. It is not a broad control-character filter or Unicode normalization policy.

## Preserved decisions

This decision preserves:

- empty attribute keys;
- otherwise accepted ordinary Unicode without implicit normalization;
- literal whitespace behavior for service and message;
- prototype-safe handling of `__proto__`, `constructor`, and other JavaScript-sensitive keys;
- original string/number/boolean attribute types;
- parameterized SQL for every user-controlled value;
- redacted database failures as defense in depth.

## Separate pending compatibility question

Unpaired UTF-16 surrogate behavior remains a separate pending compatibility question. This ADR neither rejects nor approves a new representation for unpaired surrogates and must not be interpreted as a complete policy for every possible JavaScript code-unit sequence.

## Consequences

### Positive

- Storage-incompatible entries are rejected before pool acquisition and transaction work.
- Later mixed-batch orchestration can commit ordinary entries while reporting the original indexes of NUL-invalid entries.
- Existing schema, partitions, repository SQL, JSONB strategy, and indexes remain unchanged.
- Rejection behavior is deterministic and easy to explain and test.

### Negative

- The accepted API string repertoire is narrower than all strings representable by JSON.
- Clients sending U+0000 receive an entry-level validation rejection rather than a round trip.
- The same rule must be applied consistently by future recognized query parsers.
- Adjacent malformed-Unicode behavior still requires separate evidence and review.

## Security implications

- SQL parameterization remains mandatory but cannot make an unrepresentable value storable.
- Stable reasons never reflect the hostile key or value.
- Early rejection prevents clients from deliberately forcing predictable PostgreSQL transaction failures and rollback work with U+0000 payloads.
- Database error translation remains necessary for unexpected persistence failures but is not ordinary input validation.

## Performance implications

- The compatibility check is linear in the length of relevant strings.
- It requires no storage expansion, schema migration, database retry, or additional repository query.
- Large-body, batch-size, attribute-count, key-length, and value-length policy remains separate and evidence-gated.
- No performance target is verified by this decision or its unit tests.

## Evidence and test gates

- Unit tests cover U+0000 alone and embedded in service/message strings.
- Attribute tests cover NUL-containing keys and string values, with key rejection before value validation.
- Empty keys, ordinary Unicode, whitespace, prototype-sensitive keys, numbers, booleans, omitted/empty attributes, and representative non-NUL control characters remain positive controls.
- Unknown fields containing U+0000 remain ignored.
- Validation remains deterministic and does not mutate or reuse caller objects.
- Task 4.2 must later prove mixed-batch original indexes, durable acceptance of ordinary entries, all-invalid HTTP `400`, and no repository call for an all-invalid batch.
- Stage 5 must later prove recognized PostgreSQL-bound query filters reject U+0000 with HTTP `400` before SQL.
- Public-error tests must continue proving that PostgreSQL messages, SQLSTATEs, SQL text, credentials, and raw input are not exposed.
- Performance claims require later measured load evidence under the required limits.

## Supersession

This ADR supersedes only the over-broad U+0000 portion of project decision `DEC-012` and ADRs 0003 and 0010 where they describe preserving every otherwise valid non-empty Unicode key exactly. It does not rewrite those records as though they always contained this limitation.

All other decisions in ADRs 0003 and 0010 remain accepted, including empty-key acceptance, ordinary-Unicode preservation, no implicit normalization, whitespace preservation, prototype-safe keys, parameterized SQL, and redacted database failures.

## References

- Requirements: `CORE-002`, `ING-005`, `ING-006`, `ING-009`, `ING-010`, `ING-013`, `SEC-001`, `SEC-003`
- Project decisions: `DEC-012`, `DEC-016`
- Edge cases: `EDGE-VAL-003`–`EDGE-VAL-005`, `EDGE-ATTR-003`, `EDGE-ATTR-007`, `EDGE-ATTR-008`, `EDGE-ATTR-012`, `EDGE-BAT-002`, `EDGE-BAT-007`–`EDGE-BAT-009`
- Related ADRs: ADR 0003, ADR 0010, ADR 0011
- Training: Learn TypeScript; Learn HTTP Servers in TypeScript; Learn SQL; Build a Blog Aggregator in TypeScript

## Acceptance record

The Reviewer and student approved Alternative A and the PostgreSQL-compatible string boundary wording on `2026-08-09`. The approval accepts per-entry ingestion rejection now and future recognized query-filter rejection in Stage 5 while leaving Task 4.2, query implementation, performance validation, and unpaired-surrogate policy separately gated.
