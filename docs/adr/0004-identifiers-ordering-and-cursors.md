# ADR 0004 — Identifiers, Deterministic Ordering, and Cursors

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Stage 5 after explicit task authorization

## Context

Every returned log needs a unique ID. Results sort by timestamp descending with deterministic ties, and pagination must be cursor-based. The cursor is opaque and invalid cursors return `400`.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| UUID v4 plus `(timestamp, id)` order | Built-in application generation, opaque, ready before bulk insert | Larger/random index key and probabilistic uniqueness |
| UUID v7 plus `(timestamp, id)` order | Better key locality | Trusted implementation/dependency and extra timestamp semantics |
| Database bigint sequence | Compact and ordered | Publicly sequential, bulk return mapping and partitioned uniqueness complexity |

Cursor alternatives are unsigned base64url JSON, HMAC-signed stateless data, and server-side stored cursor state. Signing authenticates cursor fields but adds secret lifecycle; server-side state adds a lookup and cleanup. Unsigned structural validation cannot prove that position fields were not changed.

## Accepted decision

**ACCEPTED — 2026-08-08:** generate UUID v4 in the application and order by `(timestamp DESC, id DESC)`. Encode a versioned base64url JSON cursor containing the last timestamp, ID, and SHA-256 fingerprint of a canonical normalized-filter object. The fingerprint includes normalized `service`, `level`, `since`, `until`, `q`, sorted resolved attribute filters, and a cursor-semantics/sort version. It excludes ignored unknown parameters, the cursor, and `limit`; omitting `limit` intentionally permits page-size changes without changing the result set or ordering.

Validate encoding, exact shape, version, timestamp, UUID, and filter-fingerprint equality. The fingerprint prevents accidental cursor reuse with different normalized filters but does not authenticate timestamp/ID position fields. A structurally valid changed position can therefore produce a different valid continuation page. This is acceptable only because the cursor is pagination state rather than an authorization boundary. Return `400` for malformed, incompatible, invalid-field, or filter-mismatched cursors.

Use read-committed keyset continuation, not a multi-request snapshot. Newer inserted rows may remain ahead of an existing cursor; retained/deleted rows may disappear. Document this limitation.

## Consequences

### Positive

- Stateless pagination with indexed tuple comparison.
- IDs exist before insertion and do not require `RETURNING` correlation.
- Filter fingerprint prevents accidental cursor reuse across queries.
- Clients may change `limit` while continuing the same ordered filtered result set.

### Negative

- Cursor is encoded, not encrypted or authenticated.
- Structurally valid timestamp/ID changes are not detectable without a signature.
- UUID indexes are larger than bigint indexes.
- Partitioned tables cannot enforce global `id` uniqueness without partition-key constraints; UUID generation carries that invariant.

## Evidence and review gates

- Codec tests for malformed base64url/JSON, wrong shape/version, invalid timestamp/UUID, and normalized-filter mismatch.
- Tests document that a structurally valid changed position is accepted and changes continuation; they do not claim universal tamper detection.
- Tests prove `limit` changes do not cause a fingerprint mismatch, while each included normalized property does.
- Multi-page integration tests prove no duplicate/missing rows, including equal timestamps.
- Concurrent insertion/deletion tests document actual continuation semantics.
- Measure UUID generation and index impact if they appear in profiles.

## References

- Requirements: `QRY-010`–`QRY-018`
- Edge cases: `EDGE-CUR-001`–`EDGE-CUR-008`
- Project decision: `DEC-014`
- Training: Learn SQL; Learn TypeScript; Learn HTTP Clients in TypeScript

## Acceptance record

The reviewer approved UUID v4 ordering, unsigned filter-bound cursors with unauthenticated position fields, and documented read-committed continuation semantics on `2026-08-08`.
