# Stage 9.3 Experiment — Client Concurrency 8

## Decision

**Rejected.** Keep client concurrency four for the controlled workload. Concurrency eight reduced throughput and increased request and aggregation latency.

Machine-readable evidence: [`../results/million-row-concurrency-8.json`](../results/million-row-concurrency-8.json).

## Controlled variable and hypothesis

Only client ingestion concurrency changed from four to eight. Batch size returned to the frozen baseline value 250; the application pool remained four. Rows, warm-up, seed, timeout, open-loop aggregation, resource limits, application code, schema, indexes, partitions, retention, validation, and durability remained unchanged.

Hypothesis: more in-flight HTTP work might overlap request parsing/validation with database waits and improve utilization. Risk: work queued ahead of the four-connection pool could increase memory and latency without improving PostgreSQL throughput.

## Exact command

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 250 `
  --concurrency 8 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/million-row-concurrency-8.json
```

The experiment ran from clean commit `b2a89cea8bfa786c811a72dd00c680841875b20e` on `perf/concurrency-8`.

## Comparable results

| Metric | Concurrency 4 baseline | Concurrency 8 | Change |
|---|---:|---:|---:|
| Confirmed throughput | 14,661.743 logs/s | 14,190.006 logs/s | **-3.22%** |
| Measured duration | 68,204.717 ms | 70,472.135 ms | worse |
| Ingestion p50 | 77.182 ms | 116.893 ms | worse |
| Ingestion p95 | 113.392 ms | 211.598 ms | **+86.61%** |
| Ingestion p99 | 190.614 ms | 299.026 ms | worse |
| Aggregation p95 | 181.599 ms | 271.192 ms | **+49.34%** |
| Freshness, dispatch to visibility | 175.415 ms | 271.765 ms | still below 20 s |
| Peak app memory | 77,290,537 bytes | 81,705,042 bytes | **+5.71%** |
| Peak PostgreSQL memory | 428,028,723 bytes | 419,325,542 bytes | -2.03% |

Both reports retain exact achieved resource-sampling cadence. Observed peaks are periodic rather than continuous maxima.

## Correctness and safety gates

- 1,000,000 measured rows confirmed accepted.
- 1,010,000 expected and observed total rows; reconciliation delta zero.
- Zero rejected, indeterminate, not-attempted, timeout, transport, or unresolved ingestion rows.
- 71 scheduled, started, completed, and successful aggregation requests; zero missed ticks.
- Aggregation p95 remained below one second.
- Public-query freshness remained below 20 seconds.
- Effective Docker controls matched the required limits.
- PostgreSQL durability settings remained enabled.
- Exact-project cleanup passed with no remaining resources.

## Interpretation

Additional in-flight HTTP work did not improve the frozen four-connection database path. It increased application CPU average slightly, increased observed application memory, and materially worsened ingestion and aggregation latency while confirmed throughput fell. The result argues against increasing client concurrency as the retained configuration.

No application default changed. Reversion means retaining client concurrency four for later controlled comparisons. A subsequent experiment should target measured per-row or serialization cost rather than add queue depth.
