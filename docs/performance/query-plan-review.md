# Query-plan review

## Purpose and evidence boundary

This review records one controlled PostgreSQL 16 execution-plan baseline for the production list and aggregation repositories before any index experiment. The machine-readable source of truth is [the generated baseline](./results/query-plan-baseline.json), including each complete `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, SETTINGS)` document, production SQL text, bound parameter array, and derived node summary.

This is query-plan evidence, not a latency-percentile or concurrent-load benchmark. In particular:

- PERF-002's aggregation result below one second at p95 remains unverified;
- PERF-003 remains unverified because ingestion was not active;
- PERF-006 requires sustaining one aggregation request per second during ingestion and remains unverified by this single-query, non-concurrent plan review;
- INF-003 application/PostgreSQL resource-limit compliance remains unverified for the complete service because the host TypeScript process was not constrained as the application container;
- ingestion throughput, freshness under load, production hardware behavior, and the final index set remain unverified.

The observed planning and execution times below are single descriptive observations. They are not p95 values.

## Reproduction

Prerequisites are the installed repository dependencies, Git, and a running Docker engine. From the repository root, run:

```text
npm run benchmark:query-plans -- --seed 20260810 --rows 1000000 --output docs/performance/results/query-plan-baseline.json
```

The CLI accepts only `--seed`, `--rows`, and `--output`. Numeric values are strict unsigned base-ten integers. These tool bounds are internal safety choices, not public API limits or company requirements.

The successful report was assembled in memory and published atomically only after the runtime pool closed, the disposable container was removed, and Docker confirmed its exact validated name no longer existed.

## Recorded source and environment

The replacement baseline completed at `2026-08-10T11:25:50.919Z` from uncommitted Task 6.3 paths based on commit `070c61d25c78b001ded711a5f5365a446902bfc2` on `feat/log-aggregation`.

| Component | Generated evidence |
| --- | --- |
| Node.js | v24.18.0 |
| npm | 11.16.0 used; package metadata requests 12.0.2 |
| Host | Windows 10.0.26200, x64 |
| CPU | Intel Core i5-14400F, 16 logical CPUs |
| Host memory | 34,187,763,712 bytes |
| Docker client | 29.6.2 |
| PostgreSQL image | `postgres:16.14-bookworm` |
| PostgreSQL server | 16.14 (Debian 16.14-1.pgdg12+1) |

The PostgreSQL container's effective controls were verified as `NanoCpus=1,000,000,000`, `Memory=1,073,741,824` bytes, automatic removal enabled, and zero persistent mounts. No mapped port, database URL, or credential is recorded.

The TypeScript runner executed on the host, so this run does not demonstrate the application limit of 0.5 CPU and 256 MiB. It verifies only the disposable PostgreSQL CPU/memory controls, not complete INF-003 compliance.

## Dataset and reconciliation

One reference timestamp, `2026-08-10T11:25:21.418Z`, was captured before partition preparation and reused for generation, ranges, and validation. Seed `20260810`, that timestamp, generator version 1, and the formula stored in the JSON reconstruct the workload.

One million synthetic rows were distributed evenly across the preceding thirty days. `shifted = ordinal + seed` selected service modulo 100, level modulo 4, empty attributes modulo 10, tenant modulo 1,000, and the sparse literal message marker modulo 1,000. Owner-only setup applied migrations, prepared partitions, inserted the data directly, and ran `ANALYZE`; this bypassed HTTP and ingestion validation and supplies no ingestion-performance evidence.

Runtime-role reconciliation observed:

| Evidence | Observed |
| --- | ---: |
| Total rows | 1,000,000 |
| Empty attribute objects | 100,000 |
| `service-007` rows | 10,000 |
| `error` rows | 250,000 |
| `tenant-000123` rows | 1,000 |
| Literal marker rows | 1,000 |
| Default-partition rows | 0 |
| Data partitions used | 31 |
| Minimum timestamp | `2026-07-11T11:25:21.418000Z` |
| Maximum timestamp | `2026-08-10T11:25:18.826000Z` |

The fixed list match counts reconciled independently, and every repository result matched `min(match count, limit + 1)`. The aggregation returned 28,808 bucket/group rows whose counts summed to its independently counted 33,333 source rows.

## Existing indexes and settings

The generated catalog evidence contains exactly the two accepted parent indexes:

- `logs_pkey` on `(timestamp, id)`;
- `logs_service_timestamp_id_idx` on `(service, timestamp DESC, id DESC)`.

The report records 70 parent/partition index catalog entries. Summed physical ordinary relations occupied 283,557,888 heap bytes and 172,007,424 index bytes in this disposable dataset. No level, JSONB GIN, or trigram index was present or added.

The established role bootstrap set both owner and runtime `TimeZone` defaults to UTC. The observed runtime setting was `TimeZone=UTC`. The report also retained the observed values `shared_buffers=16384`, `work_mem=4096`, `effective_cache_size=524288`, `random_page_cost=4`, `seq_page_cost=1`, `max_parallel_workers_per_gather=2`, and `jit=on`.

No planner switch, memory setting, cost constant, JIT setting, parallelism setting, autovacuum setting, durability setting, or other tuning setting was changed. It would be misleading to claim that no PostgreSQL setting changed at all because the established architectural bootstrap applies the UTC role default.

## Plan summary

Times are milliseconds. Buffer columns are the root plan's shared block counts. Each value is taken from the generated JSON; display is rounded only where shown.

| Scenario | Matches | Returned | Plan | Partitions planned / executed | Planning ms | Execution ms | Shared hit/read | Spill |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| Recent unfiltered list (`recent-unfiltered-list`) | 33,333 | 101 | Index Scan | 2 / 1 | 2.794 | 0.101 | 4 / 4 | No |
| Service/time list (`service-time-list`) | 2,333 | 101 | Index Scan | 8 / 1 | 3.877 | 0.278 | 101 / 3 | No |
| Level/time list (`level-time-list`) | 58,333 | 101 | Index Scan | 8 / 1 | 0.818 | 0.135 | 25 / 3 | No |
| Attribute-filtered list (`attribute-filtered-list`) | 234 | 101 | parallel Seq Scan + Gather Merge | 8 / 8 | 1.062 | 26.548 | 8,710 / 1 | No |
| Literal message-search list (`literal-message-search-list`) | 234 | 101 | parallel Seq Scan + Gather Merge | 8 / 8 | 0.774 | 107.494 | 8,711 / 0 | No |
| Primary aggregation (`primary-aggregation`) | 33,333 | 28,808 | Seq Scan + Sort + Sorted Aggregate | 2 / 2 | 0.432 | 107.621 | 1,697 / 0 | No |

All time ranges excluded unrelated partitions at planning time: the 24-hour scenarios retained two date-partition scan nodes and the seven-day scenarios retained eight. A retained scan is counted as executed only when its `Actual Loops` is greater than zero. The recent, service, and level limits obtained their page from one retained partition, so their remaining planned partition scans had zero loops. Attribute search, message search, and aggregation executed every retained partition scan. `Subplans Removed` was zero because this evidence shows static plan-time pruning rather than runtime removal. The default partition was neither planned nor executed by any baseline query.

No Incremental Sort node occurred in this baseline. The derived evidence model preserves PostgreSQL `Presorted Key`, `Full-sort Groups`, and `Pre-sorted Groups` details if a future plan supplies them.

### List-query interpretation

- The recent page used backward primary-key partition index scans. `LIMIT 101` stopped after the first active child produced the page; a planned second child had zero loops.
- The service page used each partition's service/time/ID index. Again, the newest child produced all 101 rows, so older planned children had zero loops.
- The level page used the primary time/ID index for order and range, applying level as a filter. With this deterministic distribution, one in four rows is `error`, so PostgreSQL found 101 results quickly without a level index. This single plan does not prove that a level index would or would not help other ranges or concurrent workloads.
- Attribute containment used parallel sequential scans and an in-memory quicksort/Gather Merge. The Gather Merge planned 16 rows but produced the limited 101 rows, an underestimate worth retaining for a later controlled JSONB-index experiment. The sort reported quicksort in memory with 59 kB and no temporary blocks.
- Literal message search also used parallel sequential scans and Gather Merge. Its in-memory quicksort reported 51 kB and no temporary blocks. Its 107.494 ms observation is the slowest list scenario in this run, but one cache-influenced execution is not a percentile or sufficient evidence by itself to add a trigram index.

### Aggregation interpretation

The representative project scenario covered 24 hours, five-minute buckets, and service grouping. PostgreSQL scanned the two relevant partitions sequentially, sorted 33,333 source rows in memory using quicksort with 2,928 kB, and used a sorted aggregate to emit 28,808 rows. The sort estimate was 33,304 rows versus 33,333 actual rows; the final result estimate was 33,304 versus 28,808 actual rows. No temporary blocks, external sort, multi-batch hash aggregate, or disk usage appeared.

The 107.621 ms execution observation is below one second for this isolated run, but it is not evidence for PERF-002: there was one sample, no p95 calculation, no ingestion, and no one-request-per-second aggregation stream.

## Security and role boundary

The tool invokes the production repositories and predicate builder rather than maintaining alternate query SQL. A narrow adapter prefixes only the fixed trusted `EXPLAIN` clause and sends the production SQL with its original unchanged parameter array. Every synthetic filter value remains a bound parameter. Bucket and grouping expressions continue to come from the production exhaustive trusted maps.

Every production SELECT and EXPLAIN ran through the restricted `logstream_runtime` pool. Owner access was limited to role/database bootstrap, migrations, partition preparation, deterministic setup, `ANALYZE`, and cleanup. No DELETE, TRUNCATE, ownership, or additional application privilege was granted to the runtime role.

The generated evidence includes only deterministic synthetic query values. It excludes credentials, database URLs, mapped ports, and external user data.

## Evidence-based next questions

The current evidence makes JSONB containment and literal substring search reasonable candidates for separately authorized index experiments. It does not approve GIN or trigram indexes: later work must measure query benefit together with index size, ingestion CPU/WAL/write amplification, memory, and concurrent-load behavior. The level plan is not an immediate index justification because the ordered time scan satisfied this limited page cheaply in the observed distribution.

The following remain required later:

- define and measure the final primary aggregation workload under concurrent ingestion;
- calculate real p50/p95/p99 latency over repeated requests;
- sustain one aggregation request per second during ingestion for PERF-006;
- measure query behavior during ingestion for PERF-003;
- constrain both application and PostgreSQL for INF-003;
- reconcile accepted HTTP traffic with stored rows and record CPU/memory/WAL effects before retaining any candidate index.

## Interview checkpoint

- `EXPLAIN ANALYZE` executes the SELECT, while plain `EXPLAIN` only plans it.
- Partition pruning is visible through the child partitions retained in the plan; `Subplans Removed` is not the only signal because static pruning can omit children before runtime.
- A sequential scan can be appropriate when a filter has no approved index or when reading many rows is cheaper than random index access.
- Large estimate errors can point to data-distribution or JSONB selectivity-statistics limitations.
- Shared hits came from PostgreSQL buffers; shared reads required blocks to be read into them.
- External sort, temporary blocks, disk usage, or multi-batch hashing would indicate spilling; none appeared here.
- Parameterization keeps data separate from SQL syntax even in internal diagnostic tooling.
- An index must justify its ingestion, WAL, storage, cache, and maintenance cost—not merely appear in one favorable plan.

## 2026-08-14 selective-index follow-up

The retained follow-up is [the message GiST report](./results/query-plan-message-gist.json). It used the same seed, one-million-row shape, PostgreSQL image, 1 CPU/1 GiB database controls, six production repository scenarios, restricted runtime role, and cleanup checks as the baseline. Timestamps differ because each disposable run captures a fresh reference time, so this is a controlled comparison rather than a simultaneous A/B test.

| Scenario | Baseline execution | Retained execution | Plan change |
| --- | ---: | ---: | --- |
| Literal message search | 107.494 ms | 7.860 ms | parallel sequential scans → bitmap GiST scans |
| Recent unfiltered page | 0.101 ms | 0.399 ms | ordered B-tree scan retained |
| Service/time page | 0.278 ms | 0.733 ms | service B-tree scan retained |
| Level/time page | 0.135 ms | 0.751 ms | ordered time B-tree scan retained |
| Attribute page | 26.548 ms | 70.768 ms | sequential scans retained; cache-sensitive isolated sample |
| Primary aggregation | 107.621 ms | 58.874 ms | sequential scan/sort aggregate retained |

The message-search observation improved by 92.69%. The GiST family occupied 120,012,800 bytes, increasing summed index storage from 172,007,424 to 291,553,280 bytes on this synthetic dataset. The 64-byte signature was retained over the default signature because its measured message plan was 7.860 ms rather than 24.389 ms, while the repository-only write rates were effectively similar (43,666 versus 44,001 rows/s). Those repository rates include SQL-side attribute normalization and do not represent HTTP capacity.

A JSONB `jsonb_path_ops` GIN index was tested separately and rejected. With a 256 KiB pending-list limit it completed the million-row review but its attribute plan was 26.255 ms, effectively unchanged from the 26.548 ms baseline while adding 19,546,112 bytes of index storage. The default-pending-list variant was slower on its cold plan, and combining the GIN and message candidates caused PostgreSQL to terminate under the 1 GiB limit. No level index was added because the existing time-ordered scan already stops quickly for the measured low-cardinality level page.
