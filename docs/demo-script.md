# Five-Minute LogStream Demo

## Goal and preparation

This script demonstrates the required service, its most important design choices, and genuine performance evidence in approximately five minutes. Build and start the stack before the timed portion so image download/build time does not consume the demo:

```powershell
docker compose up --build --detach
docker compose ps
```

Use a clean checkout of `main`, keep this document open, and increase the terminal font size. Do not run the million-row benchmark during a five-minute demo; show its committed evidence instead.

## 0:00–0:40 — Problem, architecture, and readiness

Say:

> LogStream accepts structured log batches, validates each item independently, commits accepted entries to PostgreSQL, and provides filtered pages and time-bucket aggregations. Fastify handles HTTP, services own behavior, repositories own parameterized SQL, and PostgreSQL remains the durable source of truth. The default Compose stack is the full core product and enforces 0.5 CPU/256 MiB for the app and 1 CPU/1 GiB for PostgreSQL.

Run:

```powershell
docker compose ps
curl.exe --fail --include http://localhost:8080/health
```

Point out `200`, `{"status":"ok"}`, and `x-request-id`. Health becomes ready only after checksum-verified migrations, partition preparation, runtime-role verification, and a live database probe.

Reference: [README architecture](../README.md#architecture) and [`src/server.ts`](../src/server.ts).

## 0:40–1:35 — HTTP to durable commit

Create a current event timestamp and submit one valid and one invalid entry:

```powershell
$demoNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$demoBody = "{`"logs`":[{`"timestamp`":`"$demoNow`",`"level`":`"info`",`"service`":`"demo-checkout`",`"message`":`"payment accepted`",`"attributes`":{`"demo_id`":`"five-minute-demo`",`"attempt`":1,`"cached`":false}},{`"timestamp`":`"invalid`",`"level`":`"info`",`"service`":`"demo-checkout`",`"message`":`"rejected item`"}]}"
$demoBody | curl.exe --silent --show-error --request POST http://localhost:8080/logs --header "content-type: application/json" --data-binary '@-'
```

Say:

> The valid row commits and the invalid row is reported at original index one. The service normalizes the timestamp, generates a UUID, preserves typed attributes, creates normalized string attributes for search, and inserts accepted rows with typed-array `UNNEST` inside one explicit transaction. HTTP 200 is returned only after COMMIT succeeds. An all-invalid batch is HTTP 400 and never calls the repository.

Show the short path if time permits:

- validation/orchestration: [`src/modules/ingestion/ingestion-service.ts`](../src/modules/ingestion/ingestion-service.ts);
- transaction and bulk SQL: [`src/modules/ingestion/ingestion-repository.ts`](../src/modules/ingestion/ingestion-repository.ts).

## 1:35–2:30 — Query, safe SQL, and cursor pagination

Run:

```powershell
curl.exe --silent --show-error --get http://localhost:8080/logs --data-urlencode "service=demo-checkout" --data-urlencode "attr.demo_id=five-minute-demo" --data-urlencode "q=payment" --data-urlencode "limit=1"
```

Say:

> Query parsing rejects duplicates and invalid bounds before SQL. User values are parameters. The `q` filter escapes SQL wildcard characters, and bucket/group expressions come only from allowlists. Pages use descending timestamp then UUID ordering. The opaque cursor stores the final tuple plus a SHA-256 filter fingerprint, so it cannot be accidentally reused with different filters. The repository asks for limit plus one and applies `(timestamp,id) < cursor`, avoiding growing OFFSET work.

Clarify the boundary:

> The cursor is canonical and filter-bound, but it is not signed, not an authorization token, and not a database snapshot.

Reference: [`query-parameter-parser.ts`](../src/modules/query/query-parameter-parser.ts), [`cursor-codec.ts`](../src/modules/query/cursor-codec.ts), and [`log-query-repository.ts`](../src/modules/query/log-query-repository.ts).

## 2:30–3:15 — JSONB, indexes, and aggregation

Run a small aggregation around the demo timestamp:

```powershell
$demoSince = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$demoUntil = (Get-Date).ToUniversalTime().AddMinutes(10).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
curl.exe --silent --show-error --get http://localhost:8080/logs/aggregate --data-urlencode "since=$demoSince" --data-urlencode "until=$demoUntil" --data-urlencode "bucket=1m" --data-urlencode "group_by=service" --data-urlencode "service=demo-checkout"
```

Say:

> Original JSONB preserves string, number, and boolean types. A second JSONB document stores deterministic strings for exact attribute containment. The primary key is `(timestamp,id)` and the only extra index is `(service,timestamp DESC,id DESC)`, inherited by daily partitions. We deliberately did not add GIN or substring indexes without evidence because each index taxes ingestion. Aggregation reuses the same predicate, uses fixed-epoch `date_bin`, and allows only four bucket sizes and two grouping columns.

Reference: [`migrations/0002_create_partitioned_log_storage.sql`](../migrations/0002_create_partitioned_log_storage.sql) and [`log-aggregation-repository.ts`](../src/modules/aggregation/log-aggregation-repository.ts).

## 3:15–3:55 — Partitions, retention, and locking

Say:

> Logs are range-partitioned by event-time day in UTC. Startup prepares the retention window and future partitions; a default partition safely catches old or uncovered timestamps. The retention worker uses a PostgreSQL advisory lock, so only one instance coordinates maintenance. It drops fully expired partitions one at a time and deletes expired default rows in bounded skip-locked batches. Shutdown aborts maintenance before closing the pool.

Explain the tradeoff:

> Partition drops make normal retention cheap, while the default partition preserves availability. Because retention uses event time, very late accepted logs can be eligible immediately.

Reference: [`migrations/0003_add_retention_routines.sql`](../migrations/0003_add_retention_routines.sql), [`retention-repository.ts`](../src/modules/retention/retention-repository.ts), and [ADR 0006](adr/0006-partitioning-and-retention.md).

## 3:55–4:35 — Tests, CI, and measured performance

Open the [final performance report](performance/final-report.md) and say:

> The result is not a microbenchmark. A repository-owned generator sends one million measured rows through public HTTP in 250-row batches at concurrency four, while scheduling aggregation open-loop once per second. It verifies effective Docker limits, durable PostgreSQL settings, public-API freshness, exact row reconciliation, and cleanup.

Show these exact results:

- retained runs: **16,031.716** and **17,059.228 confirmed accepted logs/s**;
- confirmation ingestion p50/p95/p99: **66.934 / 103.867 / 187.095 ms**;
- confirmation aggregation p50/p95/p99: **91.669 / 194.790 / 197.878 ms**;
- 59/59 aggregation calls succeeded with zero missed ticks;
- dispatch-to-visibility freshness: **96.912 ms**;
- expected/observed rows: **1,010,000 / 1,010,000**.

Say:

> Larger batches, concurrency eight, and disabling request logging were rejected. Only a strictly round-tripped canonical timestamp fast path was retained and independently confirmed. CI runs format, lint, typecheck, 1,136 unit tests, build, 86 PostgreSQL integration tests, and 12 Compose contract tests.

## 4:35–5:00 — Limitations and close

Say:

> This service intentionally has no built-in authentication, TLS, rate limiting, or explicit public batch ceiling; production needs a gateway. Attribute and substring searches can scan time-pruned partitions because no GIN or text-search index was justified. Cursors are not snapshots. Benchmark rates are specific to the recorded host and workload. Those limits are documented rather than hidden.

Close with:

> The main engineering theme is evidence-gated design: preserve the API and durability contract, keep SQL safe and storage explainable, measure end to end under real limits, and retain only changes that improve the whole system.

## Optional questions and safe extension

If asked to debug live, use the [live-debug checklist](live-debug-checklist.md). If asked for a safe small extension, propose adding a derived, non-sensitive `maintenanceActions` field to the existing retention-completion log. It changes no HTTP contract, schema, permissions, scheduling, or retention action; it still requires a focused unit test, logging review, full gates, and a fresh benchmark only if the hot path is touched.

## Cleanup after the demo

```powershell
docker compose down
git status --short --branch
```

Do not use `--volumes` if the local demo data should remain. If a clean reset is explicitly desired, explain that `docker compose down --volumes` deletes the local database before running it.
