# External Benchmark Remediation — Small-Batch Ingestion

## Scope and evidence status

The supplied external benchmark scored 44.26/100 while passing all 75 correctness checks. Its 15,000 logs/s scenario accepted 293,300 rows at 2,444.17 logs/s, returned HTTP 500 responses, had 19.13% HTTP errors, and measured ingestion and aggregation p95 near the configured two-second database timeout. PostgreSQL reached one CPU while the application remained lightly utilized. The stress, spike, and breakpoint scenarios showed the same two-second latency/error pattern.

This task targets that small-request failure mode. The incremental measurements below are controlled 100,000-row smoke tests or a 2,500-row repository microbenchmark. A final controlled one-million-row, 50-row/request confirmation is recorded separately below. None of the local evidence replaces rerunning the company benchmark.

## Retained changes

### One implicit transaction per `UNNEST` statement

The repository previously sent `BEGIN`, one set-based `INSERT`, and `COMMIT`. Because the implementation uses exactly one insert statement per public request, PostgreSQL already executes it atomically in an implicit transaction. Removing the two redundant commands preserves durability and failure behavior while reducing protocol and transaction overhead.

Identical repository command for both measurements:

```powershell
npm run benchmark:ingestion -- `
  --batch-size 25 `
  --warmup-batches 20 `
  --measured-batches 100 `
  --seed 20260813 `
  --output <temporary-json-path>
```

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Repository throughput | 8,747.755 rows/s | 20,280.208 rows/s | +131.83% |
| Batch p50 | 2.597 ms | 1.156 ms | -55.48% |
| Batch p95 | 5.177 ms | 1.794 ms | -65.34% |
| Batch p99 | 6.763 ms | 2.268 ms | -66.47% |
| Reconciled rows | 2,500/2,500 | 2,500/2,500 | exact |

The retained parameter builder was then changed from seven `map` passes to one preallocated loop. Under the same command it measured 21,570.673 rows/s (+6.36% over the implicit-transaction result) with p95 1.671 ms. Its p99 was 2.759 ms versus 2.268 ms in the preceding 100-sample run, so this small repository sample does not establish a tail-latency improvement.

### Suppress routine successful ingestion access logs

Fastify still generates and returns request IDs. Explicit validation, database, unexpected-error, startup, query, health, retention, and shutdown logging remains enabled. Only the automatic `incoming request` and `request completed` info records for `POST /logs` are suppressed. This reduces stdout and JSON-log work in request-heavy ingestion workloads.

Comparable constrained smoke command:

```powershell
npm run loadgen -- `
  --measured-rows 100000 `
  --warmup-rows 1000 `
  --batch-size 25 `
  --concurrency 4 `
  --seed 20260813 `
  --request-timeout-ms 5000 `
  --run-kind smoke `
  --output <temporary-json-path>
```

| Metric | Routine POST logs enabled | Routine POST logs suppressed | Change |
| --- | ---: | ---: | ---: |
| Confirmed throughput | 8,590.234 logs/s | 11,943.326 logs/s | +39.03% |
| Ingestion p95 | 47.577 ms | 25.317 ms | -46.79% |
| Aggregation p95 | 101.281 ms | 40.964 ms | -59.55% |
| HTTP success | 4,000/4,000 | 4,000/4,000 | exact |
| Reconciled rows | 101,000/101,000 | 101,000/101,000 | exact |

The older million-row experiment disabled routine logging globally with 250-row requests and showed no improvement. That evidence is not discarded. The accepted change is narrower and addresses a request rate ten times higher per ingested row.

### Independent connection and query timeouts

`DB_CONNECTION_TIMEOUT_MS=2000` previously controlled both connection/pool acquisition and every query. The settings are now independent: pool acquisition remains bounded at 2,000 ms so overload drains promptly, while query execution uses 10,000 ms. Exact pool and query timeout messages are classified as transient HTTP 503 responses with `Retry-After`, not internal HTTP 500 errors. This does not relax PostgreSQL durability settings or report success before commit.

## Additional retained-result smoke check

With 50-row batches and the final one-pass parameter builder, the retained code processed all 100,000 measured rows at **15,355.361 logs/s**, returned 2,000/2,000 HTTP 200 responses, reconciled 101,000/101,000 total rows, and measured aggregation p95 at 78.853 ms. Application CPU reached its 0.5-CPU allocation; PostgreSQL peaked at 52.01% in periodic samples. The preceding seven-pass run measured 14,879.834 logs/s and 40.299 ms aggregation p95. These short runs show that the target is plausible and aggregation remains far below one second, but they are too short to establish final compliance or a tail-latency improvement.

## Controlled one-million-row confirmation

Machine-readable evidence: [`results/million-row-batch-50-remediation.json`](results/million-row-batch-50-remediation.json).

Exact command:

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 50 `
  --concurrency 4 `
  --seed 20260813 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output C:/Users/97056/AppData/Local/Temp/logstream-million-batch50-remediation.json
```

The tool captured reference time `2026-08-13T18:28:36.711Z`, effective Docker controls, image identities, PostgreSQL durability/planner settings, query plans, resource samples, accounting, and cleanup evidence. That run used the retained 2,000 ms pool-acquisition/connection timeout and 10,000 ms query timeout.

| Metric | Result |
| --- | ---: |
| Confirmed measured throughput | **15,201.236 logs/s** |
| Measured POST responses | 20,000 HTTP 200; zero failures/timeouts |
| Ingestion p50 / p95 / p99 | 7.021 / 54.291 / 84.779 ms |
| Aggregation p50 / p95 / p99 | 53.072 / **146.079** / 160.174 ms |
| Aggregation schedule | 66/66 successful; zero missed ticks |
| Public dispatch-to-visibility | 46.814 ms |
| PostgreSQL reconciliation | 1,010,000 expected / 1,010,000 observed |
| Peak application CPU / memory | 51.33% / 49,650,074 bytes |
| Peak PostgreSQL CPU / memory | 98.37% / 431,593,882 bytes |
| Cleanup | verified |

The report's automated assessment verified the resource, reliability, throughput, aggregation, million-row, freshness, and one-aggregation-per-second requirements. `PERF-007` remained `not-verified` inside the generated JSON because documentation was intentionally written only after the run; this report supplies that comparative explanation without altering the generated artifact.

An intermediate experiment raised pool acquisition from 2,000 to 10,000 ms and passed a short smoke test, but the external grader later killed the complete benchmark at its five-minute command deadline. Because `pg-pool` applies the setting to queued checkout, the longer value was reverted: it exchanged prompt overload responses for a potentially long drain. The million-row artifact already verifies the retained 2,000/10,000 ms configuration.

## Rejected experiments

- A compiled Fastify success-response schema reduced small-batch throughput by 8.53%; it was reverted.
- Serialized cross-request write coalescing reduced throughput by 19.47%; it was reverted.
- Concurrent event-loop-turn coalescing reduced throughput by 7.07%; it was reverted.
- Moving UUID generation to PostgreSQL was not implemented: a direct Node measurement generated approximately 8.1 million UUIDs/s, so UUID generation was not a credible application-CPU bottleneck.

## Required next evidence

Re-run the external benchmark with the retained changes. Confirm that:

1. HTTP 500 responses around two seconds are eliminated under the 15k load and spike scenarios.
2. Confirmed accepted throughput reaches at least 15,000 logs/s under the grader's actual batch distribution.
3. Aggregation remains below one second p95 during ingestion.
4. All accepted rows reconcile after drain and no timeout-induced indeterminate work appears.
5. The scoped logging decision is reconsidered if the external request size is materially larger than the supplied benchmark suggests.

## 2026-08-14 adaptive overload batching

The next external result remained database-bound: 2,488.33 accepted logs/s, PostgreSQL near one CPU, application CPU near 10%, ingestion p95 2.09 seconds, aggregation p95 2.19 seconds, and HTTP 503 responses. Correctness remained 75/75 and every accepted row reconciled. This showed that error translation bounded overload correctly but did not add capacity.

The retained experiment adds an adaptive coordinator above the existing durable `UNNEST` repository. Up to three writes start immediately. Only requests waiting behind those writes are combined, up to 1,000 rows after at most 2 ms. Every HTTP request still waits for the shared statement to commit. The queue rejects overload with the existing HTTP 503 contract, and a single public request is never rejected merely because it exceeds an internal batch threshold.

Identical command shape for the comparison:

```powershell
npm run loadgen -- `
  --measured-rows 100000 `
  --warmup-rows 1000 `
  --batch-size 25 `
  --concurrency 64 `
  --seed 20260814 `
  --request-timeout-ms 10000 `
  --run-kind smoke `
  --output <temporary-json-path>
```

| Metric | Direct request writes | Adaptive backlog batching | Change |
| --- | ---: | ---: | ---: |
| Confirmed throughput | 8,291.276 logs/s | 12,178.509 logs/s | +46.88% |
| Ingestion p50 | 194.097 ms | 119.311 ms | -38.53% |
| Ingestion p95 | 301.984 ms | 222.798 ms | -26.22% |
| Aggregation p95 | 455.486 ms | 172.198 ms | -62.19% |
| Peak application memory | 96.3 MiB | 62.5 MiB | -35.10% |
| Peak PostgreSQL CPU | 52.79% | 29.12% | -44.84% |
| HTTP success | 4,000/4,000 | 4,000/4,000 | exact |
| Reconciled rows | 101,000/101,000 | 101,000/101,000 | exact |

The retained result does not establish the 15,000 logs/s target for 25-row requests. Application CPU reached its 0.5-CPU allocation after PostgreSQL pressure fell, identifying validation/normalization/serialization and per-request HTTP work as the next measured bottleneck. A 2,000-row always-on batch and always-on batching for low concurrency were rejected because their latency/throughput trade-offs were worse.

### Shift normalized-search construction to PostgreSQL

The application previously copied every validated attribute object into a second string-valued object and serialized both JSON documents into separate PostgreSQL parameter arrays. The retained SQL now derives `attributes_search` from the original JSONB inside each combined `UNNEST` statement. The expression is hard-coded; all user data remains parameterized. Original response value types and string-comparison behavior are unchanged and were verified by the integration and contract suites.

| Metric | Application normalization | SQL normalization | Change |
| --- | ---: | ---: | ---: |
| 25 rows, concurrency 64 throughput | 12,178.509 logs/s | 12,917.729 logs/s | +6.07% |
| 25 rows, concurrency 64 ingestion p95 | 222.798 ms | 210.846 ms | -5.36% |
| 25 rows, concurrency 64 aggregation p95 | 172.198 ms | 154.307 ms | -10.39% |
| 25 rows, concurrency 64 PostgreSQL peak CPU | 29.12% | 39.67% | +36.23% |
| 50 rows, concurrency 4 throughput | 13,752.857 logs/s | 14,693.424 logs/s | +6.84% |
| 50 rows, concurrency 4 ingestion p95 | 53.004 ms | 46.372 ms | -12.51% |
| 50 rows, concurrency 4 aggregation p95 | 87.464 ms | 79.241 ms | -9.40% |
| HTTP success and reconciliation | Exact | Exact | Preserved |

The repository-only 1,000-row microbenchmark decreased from 61,908.215 to 57,684.932 rows/s because PostgreSQL now performs the normalization work. The constrained HTTP workloads nevertheless improved because they removed application allocations and serialization from the measured 0.5-CPU bottleneck. A direct JSON response fast path was rejected after reducing throughput to 10,235.733 logs/s. Four immediate writer lanes were also rejected: throughput was unchanged while aggregation p95 rose to 238.388 ms.

### Retain only the measured message-search index

The query-plan baseline showed literal substring search as the slowest list scenario at 107.494 ms over one million rows. A partitioned `pg_trgm` GiST index with a 64-byte signature changed that scenario to bitmap index/heap scans at 7.860 ms, a 92.69% reduction in this isolated observation. The index family occupied 120,012,800 bytes. A default-size GiST signature measured 24.389 ms, while a GIN message index and the combined message/attribute candidates could not complete the million-row review inside PostgreSQL's 1 GiB limit.

The retained constrained HTTP run used the same 100,000 measured rows, 1,000 warm-up rows, batch size 25, concurrency 64, seed, and timeout as the adaptive-batching comparison. It accepted all 100,000 measured rows at 15,017.470 logs/s; ingestion p50/p95/p99 were 98.959/203.859/256.624 ms, aggregation p95 was 135.681 ms, and final reconciliation observed all 101,000 warm-up plus measured rows. Peak sampled application/PostgreSQL CPU was 52.71%/60.80%, and peak memory was 107,164,467/179,411,354 bytes. The [machine-readable load report](./results/load-generator-query-index-experiment.json) and [million-row plan report](./results/query-plan-message-gist.json) retain the full evidence and limitations.

The JSONB attribute GIN candidate was rejected: its best complete million-row cold plan was 26.255 ms versus the 26.548 ms no-index baseline, and it added 19,546,112 bytes before considering ongoing write/WAL cost. This choice protects ingestion and the resource envelope while improving the externally weak query category. It does not guarantee a particular grader score.
