# Ingestion microbenchmark

## Purpose and evidence boundary

This microbenchmark provides a repeatable functional baseline for three production-code stages:

1. per-entry validation;
2. attribute normalization;
3. transactional bulk insertion through the PostgreSQL ingestion repository.

It is not an HTTP load test or evidence that the company performance targets are met. In particular, the TypeScript process runs directly on the host rather than inside the required application limit of 0.5 CPU and 256 MB RAM. The PostgreSQL container is constrained, but the complete system is not. `INF-003` and `PERF-001` through `PERF-007` therefore remain unverified.

The machine-readable source of truth for the recorded run is [the baseline JSON](./results/ingestion-microbenchmark-baseline.json).

## Reproducing the benchmark

Prerequisites are the repository's pinned Node dependencies, Git, a running Docker engine, and permission to start a disposable local container. From the repository root, run:

```text
npm run benchmark:ingestion
```

The numeric default configuration is fixed:

| Setting | Default | Approved benchmark-tool bound |
| --- | ---: | ---: |
| Seed | 20,260,810 | 0–4,294,967,295 |
| Batch size | 1,000 rows | 1–10,000 rows |
| Warm-up batches | 2 | 1–20 |
| Measured batches | 10 | 1–100 |
| Output | `docs/performance/results/ingestion-microbenchmark-baseline.json` | Non-empty, unpadded `.json` path |

The only supported overrides are `--seed`, `--batch-size`, `--warmup-batches`, `--measured-batches`, and `--output`. Pass them after npm's `--` separator, for example:

```text
npm run benchmark:ingestion -- --seed 0 --batch-size 1000 --warmup-batches 2 --measured-batches 10 --output docs/performance/results/ingestion-microbenchmark-baseline.json
```

Numeric arguments must be unsigned base-10 integers with no sign, fraction, padding, or trailing characters. Duplicate, unknown, missing-value, and unsafe-integer arguments fail. The measured repository workload is capped at 100,000 rows and the warm-up repository workload at 20,000 rows. These are internal benchmark safety bounds, not public ingestion limits or company requirements.

## Method

The tool captures one reference timestamp before partition preparation and records its exact ISO UTC value. That same timestamp anchors partition preparation, warm-up generation, measured generation, and validation. The seed determines the services, levels, attributes, and timestamp offsets. Together, the seed and recorded timestamp anchor reconstruct the input workload. Every entry has a timestamp, level, service, message, and string/number/boolean attributes. Validation and normalization each process the full measured workload through the production functions. Counts and checksums prevent dead work from being mistaken for a measurement.

After normalization timing and its memory snapshots finish, an independent verifier derives expected search values directly from the validated original attributes. Strings remain unchanged, booleans become `"true"` or `"false"`, finite numbers use JSON/ECMAScript serialization, and negative zero becomes `"0"`. The verifier checks entry counts, exact key sets, every value, and an independently calculated expected checksum before repository records are built. Verification work is therefore excluded from the reported normalization duration.

The database phase starts `postgres:16.14-bookworm` with `--cpus 1.0`, `--memory 1g`, `--rm`, a temporary in-memory PostgreSQL data mount, and no persistent volume. Before inserting data, Docker inspection must confirm these effective controls:

- `NanoCpus` is 1,000,000,000;
- `Memory` is 1,073,741,824 bytes;
- automatic removal is enabled;
- no persistent mounts are attached.

The normal migrations and partition preparation run as the owner. The application repository continues to use the restricted `logstream_runtime` pool with a maximum of four connections; the benchmark does not grant that role deletion, truncation, ownership, or other additional privileges.

Two repository batches are inserted as warm-up. Outside all timed regions, an owner connection truncates the benchmark table. The existing PostgreSQL process and runtime pool remain alive, and a runtime query must observe zero rows before measurement begins. Ten measured repository batches then execute sequentially. Each timing surrounds the complete asynchronous repository insertion call, including its transaction. Input creation and record preparation are outside that timed region.

After insertion, a separate runtime query verifies that the accepted measured count equals PostgreSQL's row count. Its duration is recorded separately rather than included in insertion throughput. The report is assembled in memory. The runtime pool must close, the exact container must be removed, and Docker must confirm that it no longer exists before a successful report can be published. Publication uses a temporary file followed by an atomic rename; cleanup failure leaves no new successful-looking report.

## Recorded baseline

The replacement baseline was recorded at `2026-08-09T21:53:41.485Z` from uncommitted Task 4.3 sources based on commit `68d89efa1f40ede6b95a1de68dbf82e4356d65fe` on `feat/ingestion-repository`. The shared workload and partition reference timestamp was `2026-08-09T21:53:40.516Z`.

Environment:

| Component | Recorded value |
| --- | --- |
| Node.js | v24.18.0 |
| npm | 11.16.0 used by this run; package metadata requests 12.0.2 |
| Host | Windows 10.0.26200, x64 |
| CPU | Intel Core i5-14400F, 16 logical CPUs |
| Host memory | 34,187,763,712 bytes |
| Docker client | 29.6.2 |
| PostgreSQL image | `postgres:16.14-bookworm` |
| PostgreSQL server | 16.14 (Debian 16.14-1.pgdg12+1) |

The baseline therefore used npm 11.16.0 even though `package.json` requests npm 12.0.2 through both `engines` and `packageManager`. That environment mismatch is retained as evidence; this task does not change the requested package metadata.

Observed timed results:

| Stage | Operations | Timed duration | Observed rate |
| --- | ---: | ---: | ---: |
| Validation | 10,000 entries | 30.7595 ms | 325,102.814 entries/s |
| Normalization | 10,000 entries | 9.6219 ms | 1,039,295.773 entries/s |
| Repository insertion | 10,000 rows in 10 batches | 152.2400 ms | 65,685.759 rows/s |

Repository batch latency used the non-interpolated nearest-rank method:

```text
sort durations ascending
rank = ceil(percentile / 100 × sample count)
index = clamp(rank - 1, 0, sample count - 1)
```

An empty sample is an error. The recorded batch p50 was 13.6506 ms; p95 and p99 were both 23.7541 ms. With only ten samples, p95 and p99 normally select the maximum sample, so these figures are descriptive only and do not establish statistical confidence.

The owner reset was verified at zero rows. Final reconciliation observed exactly 10,000 rows for 10,000 measured operations. The separate immediate-visibility count query took 1.7043 ms. That is useful functional evidence that this run committed and exposed its rows, but it is not final proof of the 20-second freshness requirement under sustained production-like load.

The JSON also records process-memory snapshots around each stage. These are point-in-time values affected by garbage collection and shared runtime state, not isolated allocation measurements or resource-limit proof.

## Interpretation and unresolved work

This baseline confirms that the measurement path is executable, seed-controlled in workload construction, transactionally reconciled, and capable of producing a cleanup-gated report. It does not show a sustainable service rate. No HTTP parsing, response serialization, application container, concurrent clients, query traffic, aggregation traffic, million-row dataset, long-duration run, or failure injection is present.

Consequently:

- the observed repository rate must not be presented as compliance with the 15,000 logs/second target;
- the immediate count query must not be presented as final `PERF-005` evidence;
- repository p95/p99 must not be compared with the aggregation p95 target;
- this one run does not justify changing the static `UNNEST` insertion, pool size, indexes, partitioning, or PostgreSQL durability;
- final performance work must constrain both application and PostgreSQL resources, exercise HTTP with sustained and concurrent traffic, reconcile all requests and rows, include the primary aggregation load, and report bottlenecks and resource use.

The recorded baseline is therefore an initial diagnostic reference for later controlled load testing, not a performance acceptance result.
