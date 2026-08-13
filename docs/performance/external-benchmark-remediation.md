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

`DB_CONNECTION_TIMEOUT_MS=2000` previously controlled both connection/pool acquisition and every query. The supplied benchmark's p95/error boundary strongly indicates that queued work was converted into HTTP 500 responses around two seconds. `DB_QUERY_TIMEOUT_MS` is now independent, and both bounded defaults are 10,000 ms. This does not relax PostgreSQL durability settings or report success before commit.

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

The tool captured reference time `2026-08-13T18:28:36.711Z`, effective Docker controls, image identities, PostgreSQL durability/planner settings, query plans, resource samples, accounting, and cleanup evidence. That run used the stricter 2,000 ms pool-acquisition/connection timeout and the new 10,000 ms query timeout. The final Compose default subsequently raised only the pool-acquisition/connection timeout to 10,000 ms after `pg-pool` source inspection confirmed that the setting also governs queued checkout; the code and SQL path are unchanged.

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

After the pool-acquisition timeout default was raised from 2,000 to 10,000 ms, a final current-configuration 100,000-row smoke run processed **15,011.081 logs/s**, returned 2,000/2,000 HTTP 200 responses, measured ingestion p95 49.205 ms and aggregation p95 59.950 ms, exposed the freshness probe in 43.808 ms, reconciled 101,000/101,000 rows, and verified cleanup. The timeout-only change therefore did not introduce an observable smoke regression, but the million-row artifact remains the formal controlled result for the stricter acquisition setting.

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
