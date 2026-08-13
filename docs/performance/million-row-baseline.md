# Stage 9.2 — Controlled Million-Row Baseline

## Evidence status

This is the frozen pre-tuning baseline for Stage 9.3. The run completed from clean commit `5f65767d7c9a240955c288995f358f16c59c9a79` on branch `perf/million-row-baseline`.

The machine-readable source of truth is [`results/million-row-baseline.json`](./results/million-row-baseline.json). Values below are copied from that report. The report outcome `passed` means the workload, reconciliation, diagnostics, and cleanup completed; it does not mean every performance target passed.

## Hypothesis

The frozen application baseline—typed-array `UNNEST`, one transaction per public HTTP batch, shared PostgreSQL pool maximum four, daily partitions, current retention, and only the accepted primary-key and service/time index families—was expected to sustain at least 15,000 confirmed accepted logs/second with 250-row client batches at concurrency four while keeping the primary aggregation below one second p95 at an open-loop one request/second.

The aggregation hypothesis passed. The ingestion-throughput hypothesis did not: the measured result was 14,661.74 logs/second.

## Exact command and configuration

```powershell
npm run loadgen -- `
  --measured-rows 1000000 `
  --warmup-rows 10000 `
  --batch-size 250 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 10000 `
  --run-kind baseline `
  --output docs/performance/results/million-row-baseline.json
```

The tool captured reference time `2026-08-13T11:46:37.322Z`, run marker `lg-v1-013527cc-20260813t114637322z`, and isolated Compose project `logstream-loadgen-20260813114637-29500-21d995`. It verified zero pre-existing marker rows before traffic.

Effective application configuration recorded from the container:

| Setting | Value |
|---|---:|
| `PORT` | `8080` |
| `DB_POOL_MAX` | `4` |
| `DB_CONNECTION_TIMEOUT_MS` | `2000` |
| `DB_STARTUP_TIMEOUT_MS` | `30000` |
| `DB_RETRY_DELAY_MS` | `500` |
| `RETENTION_DAYS` | `30` |
| `LOG_LEVEL` | `info` |

No application, schema, index, pool, durability, validation, retention, or API setting changed for this run. Warm-up and measured rows were generated deterministically across the 28 days preceding the reference time. Warm-up data remained in PostgreSQL and was included in final reconciliation, but not in measured latency or throughput.

## Environment and effective limits

| Item | Recorded value |
|---|---|
| Host | Windows `10.0.26200`, Intel Core i5-14400F, 16 logical CPUs, 34,187,763,712 bytes RAM |
| Node.js / npm | `v24.18.0` / `11.16.0` |
| Docker | `29.6.2`, build `dfc4efb` |
| Docker Compose | `v5.3.1` |
| PostgreSQL | `16.14 (Debian 16.14-1.pgdg12+1)` |
| Application image | `sha256:01e3ef176068b34c8faf207ba8e6ce2b71d6251b6df7eaf2aa1df3870539cfd5` |
| PostgreSQL image | `sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8` |
| Application control | `NanoCpus=500000000`, memory `268435456` bytes |
| PostgreSQL control | `NanoCpus=1000000000`, memory `1073741824` bytes |

The tool inspected effective Docker `HostConfig`; it did not infer enforcement from Compose text. PostgreSQL reported `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`, `wal_level=replica`, `shared_buffers=16384` 8-KiB blocks, `work_mem=4096` KiB, and `TimeZone=UTC`. No durability setting was weakened.

## Results

### Ingestion and reconciliation

| Metric | Result |
|---|---:|
| Measured duration | 68,204.717 ms |
| Requests scheduled / started / completed | 4,000 / 4,000 / 4,000 |
| Confirmed accepted measured rows | 1,000,000 |
| Server-rejected / indeterminate / not-attempted rows | 0 / 0 / 0 |
| Confirmed accepted throughput | **14,661.743 logs/s** |
| Request latency p50 / p95 / p99 | 77.182 / 113.392 / 190.614 ms |
| Expected PostgreSQL rows | 1,010,000 |
| Observed PostgreSQL rows | 1,010,000 |
| Reconciliation delta | 0 |

`PERF-001` is **not verified** because 14,661.743 logs/s is below the required 15,000 logs/s. Reliability and exact row accounting passed: every measured request returned HTTP `200`, and PostgreSQL contained exactly the sum of confirmed warm-up and measured accepts.

### Concurrent aggregation and freshness

| Metric | Result |
|---|---:|
| Intended aggregation rate | 1 open-loop request/s |
| Scheduled / started / successful | 69 / 69 / 69 |
| Missed / unresolved ticks | 0 / 0 |
| Aggregation latency p50 / p95 / p99 | 91.785 / **181.599** / 187.605 ms |
| Scheduling lag p50 / p95 / p99 | 2.083 / 12.860 / 13.983 ms |
| Freshness, POST dispatch to public-query visibility | 175.415 ms |
| Freshness, successful acknowledgement to visibility | 86.502 ms |

The aggregation p95 target below one second passed during ingestion. The freshness target below 20 seconds also passed through `GET /logs`; PostgreSQL was not queried directly for freshness.

### Resource observations

| Resource | Average sampled | Maximum sampled |
|---|---:|---:|
| Application CPU | 48.03% | 53.48% |
| Application memory | 62,793,764 bytes | 77,290,537 bytes |
| PostgreSQL CPU | 39.56% | 89.91% |
| PostgreSQL memory | 282,867,217 bytes | 428,028,723 bytes |

The report retained 25 periodic samples over a 68,359.272 ms observation span. Docker Desktop command latency limited achieved sample starts to 0.3511/s; sample-start interval p50 was 3,057.463 ms and p95 was 3,081.142 ms. These are periodic observations, not continuous maxima, so brief resource peaks may be missed.

Database sizing after ingestion:

| Metric | Bytes / count |
|---|---:|
| Database size | 773,749,783 bytes |
| Leaf partition table bytes | 637,337,600 bytes |
| Leaf partition index bytes | 125,984,768 bytes |
| Leaf partitions including default | 34 |

## Query-plan evidence

Plans were captured after measured ingestion. They diagnose the million-row state but do not replace concurrent public-HTTP latency samples.

### Recent unfiltered page

- Planning: 4.456 ms; execution: 3.278 ms; 101 rows.
- Root: `Limit` over `Merge Append`.
- Child access: partition primary-key index scans.
- Shared blocks: 14 hits and 178 reads; no temp I/O.

The plan matches deterministic `(timestamp, id)` ordering and stops after the required page plus look-ahead row. It initializes child scans across the partition set, which is visible planning/execution overhead but small in this measured state.

### Primary aggregation

- Planning: 57.002 ms; execution: 30.945 ms; 2,312 bucket/group rows.
- Root: `Sort` over aggregate and append.
- Partition pruning retained only the two daily partitions overlapping the 24-hour range.
- The two retained children used sequential scans over 40,905 matching rows.
- Shared blocks: 106 hits and 4,572 reads; no temp I/O.

For this range and row count, sequential scans on two pruned partitions are reasonable: the query processes a substantial fraction of each day, and its measured HTTP p95 remains far below one second. Adding an index solely for this plan is not justified by the baseline.

## Bottleneck interpretation and Stage 9.3 direction

The sustained application CPU samples average 48.03% against a 0.5-CPU quota and peak slightly above 50% in Docker's periodic reporting. PostgreSQL has headroom on average but peaks near its one-CPU allocation. Client scheduling lag is low and there were no missed aggregation ticks. This supports—but does not prove—the inference that per-request application/HTTP/serialization/transaction overhead is the first bottleneck to test.

Reasonable first experiments are:

1. Increase only the client HTTP batch size while holding total rows, seed, concurrency, resource limits, service code, pool, schema, and indexes constant. Fewer requests and commits may reduce per-row overhead; larger bodies may increase latency and application memory.
2. Change pool maximum. More connections might increase overlap, but PostgreSQL has only one CPU and extra connections may increase contention. This should follow, not precede, the lower-risk batch experiment.
3. Change index inventory or ingestion method. These are larger architectural variables and are not justified before the batch-size result.

The recommended first Stage 9.3 controlled variable is batch size. No tuning result is claimed in this baseline document.

## Cleanup and limitations

Compose down, volume removal, and exact project-label verification passed. No project container, network, or volume remained.

- Results are specific to this host, Docker Desktop version, images, commit, and deterministic workload.
- Resource sampling is periodic and achieved about 0.35 starts/s because `docker stats --no-stream` is slow in this environment.
- The synthetic workload cannot represent every real production distribution.
- Post-run plans are cache/state-sensitive and are separate from concurrent HTTP latency.
- `PERF-001` and final evidence requirement `PERF-007` remain unverified at this checkpoint.
