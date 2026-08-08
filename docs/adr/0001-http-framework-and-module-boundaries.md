# ADR 0001 — HTTP Framework and Module Boundaries

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stage:** Stage 1 after explicit task authorization

## Context

The service needs exact HTTP behavior, efficient JSON handling, strong TypeScript support, readiness/shutdown hooks, and simple black-box testing under 0.5 CPU and 256 MB. It must remain understandable to a trainee.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Fastify modular monolith | Low overhead, structured logging, lifecycle hooks, good TypeScript ecosystem | Framework schemas can accidentally impose whole-batch validation; plugin model must be learned |
| Express modular monolith | Familiar and broad ecosystem | More manual typing/lifecycle work and generally higher overhead |
| Raw Node HTTP | Small dependency surface and full control | Reimplements parsing, routing, hooks, logging, and error behavior |

For internal organization, feature modules compete with global horizontal layers and a fully hexagonal design. Feature modules keep route/service/repository code together; horizontal layers scatter a feature; full hexagonal ports add ceremony without multiple real adapters.

## Accepted decision

**ACCEPTED — 2026-08-08:** use Fastify in one modular application. Organize health, ingestion, logs, aggregation, and retention by feature, each with only the route/service/repository boundaries it needs. Share configuration, database infrastructure, filters, errors, and logging. Keep `app` creation separate from the process entry/listen function.

Fastify route schemas may validate top-level shapes, but independent log-entry validation remains explicit application logic so one invalid item does not reject the batch.

## Consequences

### Positive

- One deployable process and direct function calls.
- Clear request traces for interview/demo use.
- Framework-independent validators, services, and repositories remain unit-testable.

### Negative

- The team must understand Fastify plugins, decoration, hooks, and lifecycle.
- Boundaries require discipline to avoid a large shared-utilities folder.

## Evidence and review gates

- Stage 1 type-check/build/startup smoke evidence.
- Route injection tests for malformed JSON and error mapping.
- Verify no repository accepts Fastify request/reply objects.
- Confirm app/listen separation enables tests and graceful shutdown.

## References

- Requirements: `CORE-001`, `INF-002`, `CI-001`, `SEC-003`
- Edge cases: `EDGE-ING-009`, `EDGE-BAT-006`, `EDGE-BAT-011`
- Training: Learn TypeScript; Learn HTTP Servers in TypeScript; Build a Pokedex in TypeScript

## Acceptance record

The reviewer approved Fastify and feature-oriented route/service/repository boundaries on `2026-08-08`.
