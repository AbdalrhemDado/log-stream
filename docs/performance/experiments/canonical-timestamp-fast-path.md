# Stage 9.3 Experiment — Canonical Timestamp Fast Path

## Decision

**Accepted.** A narrow fast path for the load generator's canonical millisecond UTC timestamps raised confirmed ingestion throughput above 15,000 logs/second in two controlled runs without weakening the timestamp contract.

Machine-readable evidence:

- [first run](../results/million-row-canonical-timestamp.json);
- [clean-commit confirmation](../results/million-row-canonical-timestamp-confirmation.json).

## Controlled variable and hypothesis

The application now recognizes exact `YYYY-MM-DDTHH:mm:ss.sssZ` input with a strict regular expression, parses it once, and requires an identical `Date#toISOString()` round trip. Other supported UTC and offset forms still use the original component parser and canonicalizer. Invalid calendar dates remain rejected.

Every workload, HTTP, database, resource, schema, index, pool, durability, and API variable matched the frozen batch-250/concurrency-four baseline.

Hypothesis: avoiding repeated component extraction, UTC conversion, mutable `Date` construction, and ISO reformatting for the dominant canonical input shape would reduce constrained application CPU per log enough to exceed 15,000 confirmed accepted logs/second. Risk: a shortcut could accidentally accept invalid timestamps or mishandle dates before the Unix epoch, so both cases have focused unit coverage and the fallback remains intact.

The code experiment ran from clean commit `544baf83dc53849a5269d33ac6622ab095bd4ef0` on `perf/canonical-timestamp-fast-path` after the full quality gate passed.

## Exact first-run command

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 250 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/million-row-canonical-timestamp.json
```

## First-run comparable results

| Metric | Frozen baseline | Canonical fast path | Change |
|---|---:|---:|---:|
| Confirmed throughput | 14,661.743 logs/s | 16,031.716 logs/s | **+9.34%** |
| Measured duration | 68,204.717 ms | 62,376.356 ms | **-8.55%** |
| Ingestion p50 | 77.182 ms | 70.320 ms | improved |
| Ingestion p95 | 113.392 ms | 109.963 ms | **-3.02%** |
| Ingestion p99 | 190.614 ms | 192.459 ms | effectively unchanged |
| Aggregation samples | 69 | 63 | shorter run |
| Aggregation p95 | 181.599 ms | 191.264 ms | +5.32%; still below 1 s |
| Freshness, dispatch to visibility | 175.415 ms | 103.551 ms | improved; below 20 s |
| Peak app memory | 77,290,537 bytes | 56,549,704 bytes | lower observed peak |
| Peak PostgreSQL memory | 428,028,723 bytes | 439,248,486 bytes | +2.62% |

Resource sampling is periodic and achieved 0.353 sample starts/second in the first run, so observed peaks are not continuous maxima.

## First-run correctness and safety gates

- Format, lint, typecheck, 1,119 unit tests, 86 integration tests, 12 Compose contract tests, and build passed before measurement.
- Focused unit tests cover exact canonical output, invalid calendar dates, and the pre-Unix whole-second boundary.
- 1,000,000 measured rows were confirmed accepted across 4,000 successful HTTP requests.
- 1,010,000 expected and observed total rows reconciled with delta zero.
- Zero rejected, indeterminate, not-attempted, timeout, transport, invalid-response, or unresolved ingestion rows.
- All 63 scheduled aggregation requests started and succeeded; no ticks were missed.
- Aggregation p95 was 191.264 ms and public-API dispatch-to-visibility freshness was 103.551 ms.
- Effective Docker controls matched 0.5 CPU/256 MiB for the app and 1 CPU/1 GiB for PostgreSQL.
- PostgreSQL retained `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`.
- Exact-project cleanup passed with no remaining container, network, or volume.

## Clean-commit confirmation

The same workload ran again from clean commit `966ce177a50d65624ef9548f7dac028ed07781a9`. Application code was unchanged from the first run; that commit added only the first report and experiment record.

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 250 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/million-row-canonical-timestamp-confirmation.json
```

| Metric | Frozen baseline | First optimized run | Confirmation |
|---|---:|---:|---:|
| Confirmed throughput | 14,661.743 logs/s | 16,031.716 logs/s | **17,059.228 logs/s** |
| Change from baseline | — | +9.34% | **+16.35%** |
| Margin above 15,000 | -2.26% | +6.88% | **+13.73%** |
| Ingestion p95 | 113.392 ms | 109.963 ms | **103.867 ms** |
| Aggregation p95 | 181.599 ms | 191.264 ms | **194.790 ms** |
| Freshness, dispatch to visibility | 175.415 ms | 103.551 ms | **96.912 ms** |

The two optimized runs averaged 16,545.472 confirmed accepted logs/second, and the lower run still exceeded the requirement. The confirmation also reconciled 1,010,000 expected and observed rows with delta zero; completed all 4,000 ingestion requests successfully; completed all 59 aggregation samples with no missed ticks; retained exact resource controls and durable PostgreSQL settings; and removed every exact-project container, network, and volume.

## Interpretation

Both runs support the hypothesis: timestamp validation and canonicalization sit on the per-row ingestion path, and the optimized representation is exactly the load generator's dominant timestamp shape. The general parser is still required for the public API contract, but canonical millisecond UTC input can safely avoid its extra transformations after an exact round-trip validation.

The implementation is retained because the independent confirmation improved the margin while preserving correctness, latency, resource-control, durability, and cleanup gates. This is evidence for this host and frozen workload, not a claim that all environments will reproduce the same absolute rate.
