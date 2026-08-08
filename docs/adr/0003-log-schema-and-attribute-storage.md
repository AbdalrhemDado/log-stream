# ADR 0003 — Log Schema and Attribute Storage

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stages:** Stages 2 and 3 after explicit task authorization

## Context

Responses must preserve string, number, and boolean attribute types, while `attr.<key>` equality compares values as strings. Keys are arbitrary, and writes must remain fast. Missing ingestion attributes must query as `{}`.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| One original JSONB column using `->>` | No duplicate storage; simplest writes | Generic arbitrary-key string equality is hard to index efficiently |
| Original plus normalized string JSONB | Preserves response types and enables uniform containment search | Extra CPU, storage, and write amplification |
| EAV attribute table | Relational key/value indexes | Row explosion, joins, transaction complexity, response reconstruction |
| Generated columns for selected keys | Excellent hot-key queries | Does not satisfy arbitrary keys without schema changes |

## Accepted decision

**ACCEPTED — 2026-08-08:** logical columns are event `timestamp`, UUID `id`, constrained `level`, literal-non-empty `service`, literal-non-empty `message`, `attributes JSONB`, `attributes_search JSONB`, and `created_at`. Store original values in `attributes`; in `attributes_search`, keep strings unchanged, use lowercase `"true"`/`"false"` for booleans, and use JSON/ECMAScript serialization for finite numbers, with negative zero canonicalized as `"0"`; use `{}` for missing attributes. Reject numeric inputs that JSON parsing produces as non-finite, preserve accepted response values as JSON numbers, and document IEEE-754 precision limits rather than claiming arbitrary-precision preservation.

**ACCEPTED attribute-key behavior — 2026-08-08:** accept and preserve empty ingestion keys because the company contract restricts values but does not establish a key restriction. Accept non-empty Unicode exactly as supplied, do not silently normalize it, and safely accept JavaScript-sensitive names through own-property iteration and null-prototype/internal-safe maps. Query grammar is separate: bare `attr.` has no `<key>` segment and is an invalid recognized query name, so an empty stored key is not queryable through that syntax.

## Consequences

### Positive

- API response types and search semantics are both explicit.
- A generic containment GIN index remains possible.
- Flat validation maps directly to JSONB objects.
- Ingestion does not gain an undocumented key-validity restriction.

### Negative

- Attributes are stored twice.
- Normalization and JSON serialization consume application CPU/memory.
- PostgreSQL constraints cannot fully replace runtime flat-object/type validation.

## Evidence and review gates

- Unit tests for string/boolean/number conversion, numeric boundary behavior, missing attributes, empty/Unicode/`__proto__`/`constructor` keys, own-property behavior, and no prototype mutation.
- Integration tests prove string/number/boolean query equivalence and response type preservation.
- Parser tests keep bare `attr.` invalid independently of ingestion-key acceptance.
- Measure row/table size and ingest cost against a single-JSONB experiment if dual storage is material.
- GIN is governed separately by ADR 0005.

## References

- Requirements: `ING-003`–`ING-008`, `QRY-005`, `QRY-006`, `QRY-012`, `SEC-001`
- Edge cases: `EDGE-ATTR-001`–`EDGE-ATTR-012`, `EDGE-QRY-004`
- Project decisions: `DEC-005`, `DEC-012`
- Training: Learn TypeScript; Build a Pokedex in TypeScript; Learn SQL

## Acceptance record

The reviewer approved dual JSONB storage, prototype-safe arbitrary-key preservation, the separate invalid bare-`attr.` query rule, and the finite-number canonicalization policy on `2026-08-08`. Performance and numeric-boundary tests remain future evidence, not acceptance evidence.
