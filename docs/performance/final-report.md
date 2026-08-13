# Final Performance Validation Report

## Outcome

The retained implementation satisfies the measured company performance targets under the required Docker resource controls. Two independent one-million-row optimized runs reached **16,031.716** and **17,059.228 confirmed accepted logs/second**. The lower result exceeds the 15,000 logs/second threshold, while concurrent aggregation p95 remained below one second, visibility freshness remained below 20 seconds, and PostgreSQL row reconciliation was exact.

This conclusion is scoped to the recorded host, images, commit lineage, deterministic workload, and Docker Desktop environment. It is repeatable evidence, not a claim that every machine or production distribution will have the same capacity.

## Target assessment

| Requirement | Evidence | Result |
|---|---|---|
| At least 15,000 logs/s | Two retained runs: 16,031.716 and 17,059.228 confirmed accepts/s | **Pass** |
| Aggregation p95 below 1 s during ingestion | 191.264 ms first run; 194.790 ms confirmation | **Pass** |
| At least 1,000,000 measured rows | 1,000,000 measured plus 10,000 warm-up rows per run | **Pass** |
| Freshness below 20 s | 103.551 ms first run; 96.912 ms confirmation, POST dispatch to public-query visibility | **Pass** |
| Aggregation at 1 request/s | 63/63 and 59/59 scheduled/started/successful; zero missed ticks | **Pass** |
| Exact accounting | 1,010,000 expected and observed rows in each retained run; delta zero | **Pass** |
| Documented tuning and reproducibility | Frozen baseline, four isolated experiments, retained confirmation, commands and JSON artifacts | **Pass** |

## Methodology

The repository-owned HTTP load generator uses only the public API for workload traffic:

1. Build and start a uniquely named Compose project.
2. Inspect effective container CPU and memory controls, application environment, database settings, images, and an empty run marker.
3. Send a deterministic 10,000-row warm-up.
4. Send 1,000,000 measured rows in 250-row batches at concurrency four.
5. Independently schedule an open-loop aggregation request once per second while ingestion is active.
6. Probe freshness by POSTing a marker and polling `GET /logs` until that committed row is visible.
7. Reconcile all warm-up and measured confirmed accepts against PostgreSQL by isolated run marker.
8. Capture database sizing and post-run query plans.
9. Run exact-project `docker compose down --volumes` and verify no labelled container, network, or volume remains.

Throughput is `confirmed accepted measured rows / elapsed measured-ingestion wall time`. A response counts only after a valid HTTP response reports accepted rows. The generator separately tracks rejection, timeouts, transport failures, invalid responses, indeterminate rows, and rows not attempted after an abort. This avoids presenting client dispatch as durable database throughput.

Latency percentiles are nearest-rank percentiles of completed public HTTP requests. Aggregation traffic is open-loop: ticks are anchored to wall-clock time instead of waiting for the prior call to finish. Scheduling lag and missed ticks are measured separately, so a fast-looking closed-loop test cannot hide an inability to sustain one request per second.

Freshness is measured through public endpoints rather than a direct SQL shortcut. Dispatch-to-visibility begins before the marker POST; acknowledgement-to-visibility begins after its successful response. The stricter dispatch value is used for the target assessment.

## Frozen workload and environment

| Input | Value |
|---|---:|
| Measured rows | 1,000,000 |
| Warm-up rows | 10,000 |
| HTTP batch size | 250 logs |
| Ingestion concurrency | 4 requests |
| Deterministic seed | 20260812 |
| Request timeout | 10,000 ms |
| Data distribution | Deterministic logs across the 28 days before run reference time |
| Aggregation rate | 1 open-loop request/s |
| Primary aggregation | 24-hour range, 5-minute buckets, grouped by service |
| Application pool maximum | 4 |
| Retention window | 30 days |
| Application logging | `info` |

The confirmation evidence recorded:

| Environment item | Recorded value |
|---|---|
| Host | Windows `10.0.26200`, Intel Core i5-14400F, 16 logical CPUs, 34,187,763,712 bytes RAM |
| Load-generator Node.js / npm | `v24.18.0` / `11.16.0` |
| Repository runtime pin | Node.js `24.18.0`, npm `12.0.2` |
| Docker / Compose | `29.6.2` / `v5.3.1` |
| PostgreSQL | `16.14 (Debian 16.14-1.pgdg12+1)` |
| Application image | `sha256:e2b8a23d3a6afbf08e1208d9a0ba10572de07756638087c9323b22a9bd74c5d3` |
| PostgreSQL image | `sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8` |

The host npm version is reported as observed; application images and repository metadata retained the exact npm 12.0.2 pin.

### Effective resource and durability controls

The generator inspected Docker `HostConfig`, rather than assuming the Compose declaration was applied.

| Service | CPU control | Memory control |
|---|---:|---:|
| Application | `NanoCpus=500000000` (0.5 CPU) | 268,435,456 bytes (256 MiB) |
| PostgreSQL | `NanoCpus=1000000000` (1 CPU) | 1,073,741,824 bytes (1 GiB) |

PostgreSQL reported `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`, and `wal_level=replica`. `shared_buffers` was 16,384 8-KiB blocks, `work_mem` was 4,096 KiB, JIT was enabled, and timezone was UTC. No result depends on disabling durability or relaxing the company API contract.

## Frozen pre-tuning baseline

The clean baseline at commit `5f65767d7c9a240955c288995f358f16c59c9a79` completed correctly but missed the ingestion target.

| Metric | Baseline result |
|---|---:|
| Confirmed throughput | **14,661.743 logs/s** |
| Measured duration | 68,204.717 ms |
| Ingestion latency p50 / p95 / p99 | 77.182 / 113.392 / 190.614 ms |
| Aggregation latency p50 / p95 / p99 | 91.785 / 181.599 / 187.605 ms |
| Aggregations scheduled / started / successful | 69 / 69 / 69 |
| Missed aggregation ticks | 0 |
| Scheduling lag p50 / p95 / p99 | 2.083 / 12.860 / 13.983 ms |
| Freshness, dispatch / acknowledgement | 175.415 / 86.502 ms |
| Expected / observed rows | 1,010,000 / 1,010,000 |

The outcome separated correctness from target compliance: workload execution, reconciliation, diagnostics, and cleanup passed, but 14,661.743 is below 15,000.

## Controlled experiments

Each experiment changed one intended variable and preserved the million-row workload, seed, API, schema, indexes, pool unless that was the variable, resource limits, retention, and durability. Rejected code/config changes were reverted; their evidence remains for auditability.

| Experiment | Throughput | Ingestion p95 | Aggregation p95 | Dispatch freshness | Decision |
|---|---:|---:|---:|---:|---|
| Frozen baseline | 14,661.743/s | 113.392 ms | 181.599 ms | 175.415 ms | Reference |
| Batch size 500 | 12,941.260/s | 290.117 ms | 281.627 ms | 183.293 ms | Reject: lower rate and much higher request latency |
| Concurrency 8 | 14,190.006/s | 211.598 ms | 271.192 ms | 271.765 ms | Reject: contention increased without reaching target |
| Request logging disabled | 14,496.211/s | 169.347 ms | 196.167 ms | 99.528 ms | Reject: no throughput gain; observability cost not justified |
| Canonical timestamp fast path, run 1 | **16,031.716/s** | 109.963 ms | 191.264 ms | 103.551 ms | Retain |
| Canonical timestamp fast path, confirmation | **17,059.228/s** | 103.867 ms | 194.790 ms | 96.912 ms | Confirm retain |

All experiment runs reconciled 1,010,000 expected and observed rows and completed cleanup. The larger-batch run observed application memory of 129,394,278 bytes and PostgreSQL memory of 562,036,736 bytes; this was within limits but substantially above the baseline observations. Concurrency eight increased p95 at both endpoints. Disabling request logging did not establish a repeatable benefit and would have reduced operational visibility.

The retained change recognizes the load generator's dominant exact `YYYY-MM-DDTHH:mm:ss.sssZ` form with a strict regular expression, parses once, and requires an identical `Date.toISOString()` round trip. All other supported timezone-bearing forms still use the general parser. Invalid calendar dates and pre-Unix boundary behavior have focused tests. This reduces per-row timestamp work without changing accepted inputs, stored precision rules, durability, or API output.

## Retained result details

The first optimized run used source commit `544baf83dc53849a5269d33ac6622ab095bd4ef0`. The clean-commit confirmation ran from `966ce177a50d65624ef9548f7dac028ed07781a9`; application code was unchanged, because that commit added only the first evidence report.

| Metric | Optimized run 1 | Confirmation |
|---|---:|---:|
| Confirmed throughput | 16,031.716 logs/s | **17,059.228 logs/s** |
| Margin above 15,000 | 6.88% | 13.73% |
| Ingestion p50 / p95 / p99 | 70.320 / 109.963 / 192.459 ms | **66.934 / 103.867 / 187.095 ms** |
| Aggregation p50 / p95 / p99 | 90.393 / 191.264 / 289.177 ms | **91.669 / 194.790 / 197.878 ms** |
| Aggregations scheduled / started / successful | 63 / 63 / 63 | 59 / 59 / 59 |
| Missed ticks | 0 | 0 |
| Confirmation scheduling lag p50 / p95 / p99 | — | 0.071 / 2.335 / 2.640 ms |
| Freshness, dispatch / acknowledgement | 103.551 / 19.888 ms | **96.912 / 48.114 ms** |
| Expected / observed rows | 1,010,000 / 1,010,000 | 1,010,000 / 1,010,000 |

The average of the two retained throughputs is 16,545.472 logs/s. The pass does not depend on that average: the lower independent run already exceeds the requirement.

### Confirmation resource observations

| Resource | Maximum sampled |
|---|---:|
| Application CPU | 52.18% |
| Application memory | 69,499,617 bytes |
| PostgreSQL CPU | 87.48% |
| PostgreSQL memory | 443,967,078 bytes |

Resource collection was periodic and achieved only about 0.35 sample starts per second because `docker stats --no-stream` was slow under Docker Desktop. These are observed peaks, not continuous maxima; short spikes can be missed. CPU percentages are Docker samples relative to host CPU accounting while the effective NanoCPU limits above are the enforcement evidence.

After confirmation, PostgreSQL contained 34 leaf partitions including the default partition. Database size was 774,437,911 bytes; leaf table bytes were 637,378,560 and leaf index bytes were 126,648,320.

## Query-plan evidence and bottlenecks

Plans were captured after ingestion completed, so they diagnose the million-row database state but do not replace concurrent public-HTTP latency samples.

- The confirmation's recent unfiltered page planned in 4.431 ms and executed in 2.760 ms for 101 rows. `Limit` stops a chronological merge of partition primary-key index scans after the requested page plus one look-ahead row.
- The primary 24-hour/5-minute/service aggregation planned in 10.138 ms and executed in 21.916 ms, returning 2,312 bucket/group rows. It used in-memory quicksort (216 KiB) with zero temporary reads or writes.
- Partitioning confines the aggregation time range to overlapping daily leaves. For a range covering a substantial fraction of those leaves, sequential scanning and aggregation can be cheaper than another write-amplifying index.

The frozen baseline showed sustained application CPU close to its 0.5-CPU allocation and occasional PostgreSQL samples close to its one-CPU allocation, while aggregation scheduling lag stayed low and no ticks were missed. Together with the successful timestamp optimization, this supports the inference that per-row validation/canonicalization and HTTP/serialization/transaction work—not client scheduling—was the first bottleneck for this workload. It does not prove the same bottleneck for different messages, attribute selectivity, storage, or hardware.

Potential future bottlenecks are deliberately visible:

- attribute containment has no GIN index, and message search is an escaped literal `ILIKE`, so low-selectivity filtered queries can scan time-pruned leaves;
- global chronological pages initialize scans across relevant partitions;
- larger batches can raise parsing memory and tail latency even when request count falls;
- higher client concurrency can contend on a one-CPU PostgreSQL container and the four-connection pool;
- database size and index maintenance grow with retention length and event volume;
- late event timestamps land in the default partition and may immediately qualify for retention.

Additional indexes, batching changes, pool changes, or PostgreSQL tuning should therefore be accepted only after a controlled workload shows an end-to-end improvement without breaking latency, memory, correctness, or resource gates.

## Reproduction

Run the quality and system gates first:

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run test:integration
npm run test:contract
```

Then run the frozen million-row workload:

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 250 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/reproduction.json
```

The load generator creates an isolated Compose project and removes it in `finally` cleanup. Do not compare a run that changes resource controls, dataset, batch size, concurrency, seed, pool, schema, indexes, durability, retention, application code, or aggregation schedule as if it were a confirmation.

## Evidence inventory

- [Frozen baseline narrative](million-row-baseline.md) and [machine-readable baseline](results/million-row-baseline.json)
- [Batch-size 500 experiment](experiments/batch-size-500.md) and [JSON](results/million-row-batch-500.json)
- [Concurrency-eight experiment](experiments/concurrency-8.md) and [JSON](results/million-row-concurrency-8.json)
- [Request-logging experiment](experiments/disable-request-logging.md) and [JSON](results/million-row-no-request-logging.json)
- [Retained timestamp experiment](experiments/canonical-timestamp-fast-path.md)
- [First retained run JSON](results/million-row-canonical-timestamp.json)
- [Confirmation JSON](results/million-row-canonical-timestamp-confirmation.json)
- [Load-generator contract](load-generator.md)
- [Testing and performance ADR](../adr/0011-testing-and-performance-validation.md)

Each JSON report includes the source commit, exact configuration, workload accounting, latency samples, environment, effective controls, durability settings, resource observations, reconciliation, diagnostics, target assessment, cleanup result, and measurement limitations.

## Limitations

- The synthetic data distribution is deterministic and useful for comparison, but it cannot represent every production workload.
- Absolute results are specific to this Windows/Docker Desktop host and captured image/runtime versions.
- Periodic resource sampling can miss short CPU or memory peaks.
- Post-run query plans are cache- and state-sensitive and are not concurrent latency measurements.
- The service does not implement authentication, TLS, rate limiting, or a public maximum batch-size setting; production gateways must add those controls.
- The confirmation proves the required workload at this checkpoint, not unlimited horizontal or vertical scalability.
- Retention behavior, disk speed, message length, attribute density, timestamp distribution, and query selectivity can materially change results.

No benchmark result in this report is estimated. Displayed values are copied or rounded from the linked machine-readable artifacts; the JSON files remain the numeric source of truth.
