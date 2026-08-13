# Stage 9.3 Experiment — HTTP Batch Size 500

## Decision

**Rejected.** Keep the frozen batch-size-250 baseline. Batch size 500 reduced throughput and increased latency and memory.

Machine-readable evidence: [`../results/million-row-batch-500.json`](../results/million-row-batch-500.json).

## Controlled variable and hypothesis

Only client HTTP/database batch size changed from 250 to 500. The experiment retained:

- 1,000,000 measured and 10,000 warm-up rows;
- seed `20260812` and the same relative 28-day distribution;
- client concurrency four and 10-second request timeout;
- one open-loop primary aggregation request per second;
- exact Docker CPU/memory controls;
- application pool maximum four;
- typed-array `UNNEST`, schema, indexes, partitions, retention, validation, API behavior, and durability settings.

Hypothesis: halving HTTP requests and transactions from 4,000 to 2,000 would reduce per-row overhead enough to exceed 15,000 confirmed accepted logs/second. Risk: larger JSON bodies and arrays could increase serialization, transaction latency, and memory.

## Exact command

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 500 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/million-row-batch-500.json
```

The experiment ran from clean commit `ec87ab3323be4fcb2c4df9fc894d81ebf35c598f` on `perf/batch-size-500`.

## Comparable results

| Metric | Batch 250 baseline | Batch 500 | Change |
|---|---:|---:|---:|
| Confirmed throughput | 14,661.743 logs/s | 12,941.260 logs/s | **-11.73%** |
| Measured duration | 68,204.717 ms | 77,272.226 ms | +13.29% |
| Ingestion p50 | 77.182 ms | 117.280 ms | worse |
| Ingestion p95 | 113.392 ms | 290.117 ms | **+155.85%** |
| Ingestion p99 | 190.614 ms | 395.713 ms | worse |
| Aggregation samples | 69 | 78 | longer run |
| Aggregation p95 | 181.599 ms | 281.627 ms | **+55.08%** |
| Freshness, dispatch to visibility | 175.415 ms | 183.293 ms | still below 20 s |
| Peak app memory | 77,290,537 bytes | 129,394,278 bytes | **+67.41%** |
| Peak PostgreSQL memory | 428,028,723 bytes | 562,036,736 bytes | **+31.31%** |

Both runs used periodic resource sampling whose achieved cadence is recorded in their JSON reports. Peaks are observations, not continuous maxima.

## Correctness and safety gates

- 1,000,000 measured rows confirmed accepted.
- 1,010,000 expected and observed total rows; reconciliation delta zero.
- Zero rejected, indeterminate, not-attempted, timeout, transport, or unresolved ingestion rows.
- 78 scheduled, started, completed, and successful aggregation requests; zero missed ticks.
- Aggregation p95 remained below one second.
- Freshness remained below 20 seconds through the public query API.
- Effective Docker controls matched the required limits.
- PostgreSQL retained `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`.
- Exact-project cleanup passed with no remaining container, network, or volume.

## Interpretation

Fewer requests did not compensate for the larger per-request JSON, typed-array, database-parameter, and transaction working sets. The larger batch increased both application and PostgreSQL observed memory and materially worsened ingestion and aggregation latency. This is evidence against retaining batch size 500 on this host and workload.

No application default or service code changed, so reversion means retaining the batch-size-250 baseline for subsequent comparisons. The next experiment must change a different single major variable.
