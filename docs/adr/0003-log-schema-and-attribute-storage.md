# ADR 0003 — Log Schema and Attribute Storage

- **Status:** `PROPOSED — NOT APPROVED`
- **Decision owner:** project review checkpoint
- **Implementation stages:** Stages 2 and 3 after approval

## Context

Responses must preserve string, number, and boolean attribute types, while `attr.<key>` equality compares values as strings. Keys are arbitrary, and writes must remain fast. Missing ingestion attributes must query as `{}`.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| One original JSONB column using `->>` | No duplicate storage; simplest writes | Generic arbitrary-key string equality is hard to index efficiently |
| Original plus normalized string JSONB | Preserves response types and enables uniform containment search | Extra CPU, storage, and write amplification |
| EAV attribute table | Relational key/value indexes | Row explosion, joins, transaction complexity, response reconstruction |
| Generated columns for selected keys | Excellent hot-key queries | Does not satisfy arbitrary keys without schema changes |

## Proposed decision

**PROPOSED — not approved:** logical columns are event `timestamp`, UUID `id`, constrained `level`, literal-non-empty `service`, literal-non-empty `message`, `attributes JSONB`, `attributes_search JSONB`, and `created_at`. Store original values in `attributes`; in `attributes_search`, keep strings unchanged, use lowercase `"true"`/`"false"` for booleans, and use one documented canonical spelling for finite numbers; use `{}` for missing attributes. Numeric canonicalization and behavior outside JavaScript's safe/finite range require focused compatibility examples and approval before implementation.

**PROPOSED attribute-key behavior:** accept and preserve empty ingestion keys because the company contract restricts values but does not establish a key restriction. Accept non-empty Unicode exactly as supplied, do not silently normalize it, and safely accept JavaScript-sensitive names through own-property iteration and null-prototype/internal-safe maps. Query grammar is a separate decision: bare `attr.` still has no `<key>` segment and remains an invalid recognized query name under the current proposal, so an empty stored key is not queryable through that syntax. This proposes a compatibility-safe resolution for `DEC-012` but remains unapproved.

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

## Approval questions

1. Approve dual JSONB rather than single JSONB or EAV?
2. Approve accepting/preserving empty ingestion keys, keeping bare query name `attr.` invalid, and safely preserving Unicode/JavaScript-sensitive keys?
3. Approve the proposed primitive string-conversion rules after numeric boundary examples are documented?
