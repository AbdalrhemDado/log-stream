# ADR 0012 — Optional Additions Posture

- **Status:** `ACCEPTED`
- **Decision date:** `2026-08-08`
- **Decision owner:** project review checkpoint
- **Implementation stage:** After core contract and measured performance acceptance

## Context

Optional features can distinguish the project, but they cannot alter the fixed load-generator contract, require configuration for default startup, consume scarce resources needed by the core, or delay proof of the mandatory behavior.

## Alternatives

| Alternative | Advantages | Disadvantages |
|---|---|---|
| Build authentication and tenancy early | Demonstrates broader product design | Expands schema, routing, test matrix, and compatibility risk before the core is proven |
| Add lightweight operational diagnostics after the core | Helps explain performance and incidents with limited contract impact | Still consumes implementation and validation time |
| Implement no optional features | Lowest delivery risk | Fewer operational/demo differentiators |

## Accepted decision

**ACCEPTED — 2026-08-08:** freeze optional feature implementation until the mandatory API, Docker startup, retention, CI, and measured performance gates pass. If schedule and resource headroom remain, prioritize in this order:

1. lightweight internal metrics and benchmark diagnostics that do not change required response bodies;
2. documented query-plan and operational troubleshooting aids;
3. only then consider disabled-by-default authentication with a fully tested unauthenticated default mode.

Do not add multi-tenancy, a queue, cache, proxy, dashboard, rate limiter, or external observability stack merely for appearance. Any optional feature needs its own review showing default-off or additive behavior, resource cost, security model, contract regression coverage, and removal/fallback path.

## Consequences

### Positive

- Protects the load-generator contract and limited performance budget.
- Directs polish toward evidence useful in a demonstration and interview.
- Gives every optional feature an explicit value and regression gate.

### Negative

- Authentication and tenancy may not be included in the final submission.
- Operational polish is intentionally delayed until late stages.
- Metrics still require a bounded-cardinality design to avoid self-inflicted overhead.

## Evidence and review gates

- Full plain-core contract and load suite passes with every optional feature absent or disabled.
- Before/after CPU, memory, latency, and throughput comparison for any optional runtime feature.
- If authentication is chosen, CI covers default unauthenticated mode and enabled seeded-key mode; health remains public.
- Metrics tests prevent unbounded labels from service names, messages, attribute keys, or attribute values.

## References

- Requirements: `OPT-001`–`OPT-007`, `INF-001`, `INF-003`, `HLT-003`, `PERF-001`–`PERF-007`
- Edge cases: `EDGE-OPT-001`–`EDGE-OPT-005`
- Training: Learn HTTP Servers in TypeScript; Learn HTTP Clients in TypeScript; Learn Docker; Learn TypeScript; Build a Blog Aggregator in TypeScript

## Acceptance record

The reviewer approved deferring all optional implementation until the core gates pass, with lightweight metrics/diagnostics as the first possible differentiators and authentication remaining only a later backlog candidate, on `2026-08-08`.
