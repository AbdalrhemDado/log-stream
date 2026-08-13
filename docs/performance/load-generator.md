# Reproducible HTTP Load Generator

## Purpose and evidence boundary

`tools/loadgen` is an external TypeScript client for Stage 9 performance validation. It runs on the host, starts an isolated instance of the existing Docker Compose stack, and sends every workload row through the public `POST /logs` API. PostgreSQL is used only after the HTTP workload for evidence reconciliation.

The tool measures ingestion and the project's established primary aggregation workload concurrently. It also verifies effective container controls, checks public-query freshness, samples container resources, and removes only the uniquely named Compose project that it created.

Task 9.1 validates the measurement tool. A bounded smoke report is not the controlled Stage 9.2 one-million-row benchmark and does not verify `PERF-001`, `PERF-002`, or any other final performance target.

## Command

Run managed mode from the repository root:

```powershell
npm run loadgen -- `
  --measured-rows 5000 `
  --warmup-rows 500 `
  --batch-size 100 `
  --concurrency 4 `
  --seed 20260812 `
  --request-timeout-ms 5000 `
  --run-kind smoke `
  --reference-time 2026-08-12T12:00:00.000Z `
  --output docs/performance/results/load-generator-smoke.json
```

Omit `--reference-time` to capture one UTC reference timestamp at process start. Supplying it makes payload generation reproducible, but it must be appropriate for the current retention window and must not be more than five minutes in the future when requests reach the service.

The JSON report contains the exact sanitized reproduction argument array. It never contains database URLs, credentials, payload bodies, or full API responses.

## Strict CLI options

| Option | Default | Tool safety range | Meaning |
|---|---:|---:|---|
| `--measured-rows` | `5000` | `1`–`5,000,000` | Rows in the measured ingestion phase. The limit supports the required one-million-row run. |
| `--warmup-rows` | `500` | `0`–`1,000,000` | Real rows sent before measurement. They remain in PostgreSQL and are reconciled. |
| `--batch-size` | `100` | `1`–`50,000` | Rows per public `POST /logs` request. The final request may be smaller. |
| `--concurrency` | `4` | `1`–`256` | Maximum concurrent ingestion requests from the client. |
| `--seed` | `20260812` | `0`–`4,294,967,295` | Unsigned deterministic workload seed. |
| `--output` | `docs/performance/results/load-generator-smoke.json` | JSON path | Atomic machine-readable report destination. |
| `--request-timeout-ms` | `5000` | `100`–`120,000` | Per-request timeout. |
| `--reference-time` | captured once | strict UTC ISO 8601 | Optional explicit workload reference time. |
| `--base-url` | `http://127.0.0.1:8080` | managed local URL only | Public application URL. Credentials are prohibited. |
| `--run-kind` | `smoke` | `smoke` or `baseline` | Declares whether final targets are not evaluated or assessed from a controlled million-row run. |

The tool schedules at most 250,000 ingestion requests. These are client safety limits, not limits on the public API. Unknown, duplicate, missing-value, partial-numeric, unsafe-integer, and out-of-range options fail before Compose startup.

## Deterministic workload

Every row is a pure function of:

```text
generator version + seed + reference timestamp + phase + global row ordinal
```

Batching, concurrency, request completion order, and worker scheduling therefore cannot change payload content.

Timestamps are distributed across the 28 days preceding the reference time. This represents approximately one month while avoiding placement directly on the active 30-day retention cutoff. The distribution includes:

- `checkout`, `auth`, `catalog`, `payments`, `orders`, `inventory`, `shipping`, and `notifications` services;
- weighted levels: 10% debug, 65% info, 18% warn, and 7% error;
- several synthetic operational message templates;
- string, number, and boolean attributes.

Every row contains `loadgen_run_id`, `loadgen_phase`, and `loadgen_sequence`, plus other safe synthetic fields. The markers support exact PostgreSQL reconciliation and a unique freshness query. The normal workload intentionally contains no invalid entries.

## Warm-up and measurement

Warm-up ingestion happens first. Its rows are committed and included in final database reconciliation, but its latency and throughput samples are never mixed with the measured phase. One aggregation warm-up request must succeed before measured statistics begin.

Measured ingestion uses a fixed worker pool and sends each batch exactly once. There is no automatic POST retry because the API has no idempotency key: retrying after a lost response could duplicate rows that PostgreSQL already committed.

Measured confirmed throughput is:

```text
confirmed accepted measured rows
÷
wall-clock time from first measured POST dispatch to final measured POST terminal outcome
```

Attempted-row rate is reported separately. Durations use a monotonic clock.

## Accounting and failures

For ingestion, the report records scheduled, started, completed, not-started, and unresolved requests; status counts; transport failures; timeouts; invalid bodies; scheduled rows; attempted rows; not-attempted rows; confirmed accepted rows; server-rejected rows; and indeterminate rows.

Every scheduled request and row must satisfy:

```text
requests scheduled = requests started + requests not started
requests started   = requests completed + requests unresolved
rows scheduled     = rows attempted + rows not attempted
```

Every attempted row must satisfy:

```text
attempted = confirmed accepted + server rejected + indeterminate
```

A timeout, transport failure, unexpected HTTP failure, or malformed success body cannot prove whether a request committed, so its rows remain indeterminate. Reconciliation is allowed to expose a difference; counters are never rewritten to make them agree.

## Concurrent aggregation and coordinated omission

During measured ingestion, the tool schedules this project benchmark query at an open-loop rate of one request per second:

```text
since    = reference time - 24 hours
until    = reference time + 1 millisecond
bucket   = 5m
group_by = service
```

This query matches the established query-plan baseline. It is a project benchmark decision, not company-prescribed query wording.

Deadlines are absolute monotonic times. The scheduler does not wait for one response and then sleep, which would hide slow periods through coordinated omission. Requests may overlap up to four in flight. When the event loop is late or the overlap bound is full, ticks are recorded as late or missed; the client does not issue an uncontrolled catch-up burst. Scheduling stops when measured ingestion ends, then outstanding requests drain for at most ten seconds and receive an abort signal with a bounded grace period.

The report includes intended and achieved start rates, scheduled and missed ticks, scheduling lag, all failure categories, successful-response latency, and all-terminal-outcome latency. Aggregation bodies are structurally validated, but bucket payloads are not retained in the report.

## Percentiles

Latency and scheduling-lag p50, p95, and p99 use the non-interpolated nearest-rank method:

1. sort samples ascending;
2. compute `rank = ceil(percentile × sample count)`;
3. use `clamp(rank - 1)` as the zero-based index.

Units are milliseconds. Empty populations use `null` percentiles and an explicit reason; zero is never invented. Percentiles use the complete in-memory population. Up to 20,000 raw samples per population are retained in the JSON for audit, with a truncation flag when the population is larger.

## Freshness evidence

The first deterministic measured row is the freshness probe. After its POST is confirmed successful, the client polls public `GET /logs` with exact `loadgen_run_id`, phase, and sequence attributes. It records:

- POST dispatch to first query visibility;
- successful POST acknowledgement to first query visibility;
- poll count and poll failures.

Polling stops after 20 seconds. It never reads PostgreSQL directly for freshness.

## Managed Compose lifecycle and resources

Managed mode:

1. creates and validates a unique `logstream-loadgen-*` Compose project name;
2. confirms `127.0.0.1:8080` is free;
3. runs `docker compose -p <exact-project> up --build --detach`;
4. polls public `/health`;
5. identifies both containers through that exact project;
6. inspects effective Docker `HostConfig` controls;
7. samples `docker stats` during measured ingestion;
8. reconciles rows;
9. runs exact-project `down --volumes --remove-orphans`;
10. verifies that no container, network, or volume with that project label remains.

The run fails unless inspected controls equal:

| Service | `NanoCpus` | Memory bytes |
|---|---:|---:|
| application | `500000000` | `268435456` |
| PostgreSQL | `1000000000` | `1073741824` |

Compose text alone is not treated as enforcement evidence. CPU percentages and memory usage are sampled once per second; samples and maxima are reported. Periodic sampling can miss brief peaks and adds a small amount of host/client work.

All child processes use shell-disabled execution with argument arrays. Project names and run markers are validated. No command string is assembled from CLI input.

## PostgreSQL reconciliation

Before HTTP traffic, fixed SQL confirms that the isolated database has zero rows for the run marker. After all HTTP work and before cleanup, the same fixed query counts rows with that exact marker. The marker is supplied as a validated `psql` variable; it is not interpolated into SQL or a shell command.

Expected rows are the sum of confirmed warm-up and measured HTTP accepts. The report contains pre-existing, expected, observed, delta, and pass/fail values. All workload writes still enter through `POST /logs`; direct database access is evidence-only.

## Controlled baseline diagnostics and target assessment

`--run-kind baseline` adds evidence collection after measured ingestion and HTTP/PostgreSQL reconciliation but before cleanup. It captures:

- a strict allowlist of non-secret application environment values and rejects drift from the frozen baseline;
- immutable application and PostgreSQL container image identities;
- PostgreSQL settings relevant to memory, planning, WAL, and durability, including `fsync`, `synchronous_commit`, and `full_page_writes`;
- database, leaf-partition, table, and index sizes;
- `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)` for the recent unfiltered page and primary aggregation.

The plans are post-ingestion diagnostics. Concurrent aggregation latency comes only from public HTTP samples collected during ingestion; the report does not mislabel post-run `EXPLAIN ANALYZE` time as concurrent request latency.

The report assesses each resource, reliability, and performance requirement with an explicit `verified`, `not-verified`, or `not-evaluated` status and the exact measured predicate. `outcome: passed` means the workload, reconciliation, diagnostics, and cleanup completed correctly; it does not by itself mean every performance target passed. Smoke runs always use `not-evaluated` for final targets.

## Report publication and cleanup guarantees

The versioned report is written to a unique temporary file and atomically renamed. It is not given a `passed` outcome until reconciliation and cleanup verification are known. An honest failed report may be published for a completed run with workload errors, and the process exits nonzero.

Cleanup is attempted from a `finally` path after success, command failure, request failure, timeout, SIGINT, or SIGTERM. Only the exact generated Compose project is targeted. Cleanup failures do not replace the primary error; both are represented safely. The report never copies Docker stderr, HTTP bodies, SQL values, stack traces, credentials, or environment secrets.

## Client-side limitations

- The Node client, JSON serialization, host network stack, Docker Desktop virtualization, and event-loop scheduling can become bottlenecks. Stage 9.2 must interpret client and server telemetry together.
- One host process generates data and schedules both ingestion and aggregation. Scheduling lag and missed ticks reveal some client saturation but do not eliminate it.
- `docker stats` is periodic rather than continuous.
- The synthetic distribution is reproducible and realistic enough for comparison, but it cannot represent every production message or attribute distribution.
- A supplied old reference time can place rows near or beyond retention eligibility; a supplied future time can violate ingestion validation.
- The smoke dataset is deliberately far below one million rows. Its throughput and latency are tool-validation observations only.
