# Stage 9.3 Experiment — Disable Automatic Request Logging

## Decision

**Rejected and reverted.** Fastify's automatic successful-request logging remains enabled because disabling it did not improve confirmed ingestion throughput and worsened measured latency.

Machine-readable evidence: [`../results/million-row-no-request-logging.json`](../results/million-row-no-request-logging.json).

## Controlled variable and hypothesis

The experiment set `disableRequestLogging: true` on Fastify's `LogController`. It retained explicit rejected/unexpected-request error logs, startup/retention/shutdown/database logs, and request ID behavior. Every other application, workload, database, resource, schema, index, pool, durability, and API variable matched the frozen batch-250/concurrency-four baseline.

Hypothesis: removing two routine structured log records per successful request would reduce application serialization/stdout CPU enough to exceed 15,000 logs/second. Trade-off: less routine request observability.

The code experiment commit was `a416ca4d9410446343eb58a1c67e20321fa54147`. It was reverted by `15c071f` after measurement.

## Exact command

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 250 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/million-row-no-request-logging.json
```

## Comparable results

| Metric | Logging enabled baseline | Automatic logging disabled | Change |
|---|---:|---:|---:|
| Confirmed throughput | 14,661.743 logs/s | 14,496.211 logs/s | **-1.13%** |
| Measured duration | 68,204.717 ms | 68,983.544 ms | worse |
| Ingestion p50 | 77.182 ms | 77.154 ms | effectively unchanged |
| Ingestion p95 | 113.392 ms | 169.346 ms | **+49.35%** |
| Ingestion p99 | 190.614 ms | 218.110 ms | worse |
| Aggregation p95 | 181.599 ms | 196.167 ms | **+8.02%** |
| Freshness, dispatch to visibility | 175.415 ms | 99.528 ms | improved; both far below 20 s |
| Peak app memory | 77,290,537 bytes | 72,446,116 bytes | **-6.27%** |
| Peak PostgreSQL memory | 428,028,723 bytes | 427,819,008 bytes | effectively unchanged |

The memory observation improved, but the throughput target remained unmet and throughput/latency did not improve overall. One run cannot prove small differences are causal; importantly, it provides no evidence sufficient to justify the observability loss.

## Correctness and safety gates

- Full format, lint, typecheck, unit, integration, contract, and build gates passed before measurement.
- The focused unit test proved routine request logs were suppressed while centralized unexpected-error logging remained.
- 1,000,000 measured rows confirmed accepted.
- 1,010,000 expected and observed total rows; reconciliation delta zero.
- Zero ingestion errors, indeterminate rows, or unresolved work.
- 69 successful aggregation requests and zero missed ticks.
- Aggregation p95 and freshness remained within required thresholds.
- Effective Docker controls and PostgreSQL durability settings remained correct.
- Exact-project cleanup passed.

## Interpretation

Automatic request logging was not the limiting variable in this environment. Docker's stdout path and application work may already buffer efficiently enough that removing access logs does not materially improve the constrained request path. The observed lower app memory is useful but does not outweigh the lack of throughput improvement and reduced routine observability.

The experiment was reverted with a normal commit; no history was rewritten. Subsequent experiments use the original logging behavior.
