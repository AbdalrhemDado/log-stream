# Live Debugging and Safe Extension Checklist

This checklist is designed for a demo, interview, or incident-style exercise on the local Compose stack. Start read-only, preserve evidence, and scope every mutable command to the exact project.

## Safety boundary

Before touching the environment:

```powershell
git status --short --branch
docker compose config --services
docker compose ps --all
```

Rules:

- Do not reset, clean, amend, force-push, or delete branches to make a symptom disappear.
- Do not run recursive filesystem deletion or broad Docker prune commands.
- Do not use `docker compose down --volumes` unless deletion of this project's local database is explicitly intended.
- Do not print database URLs, passwords, tokens, submitted messages, or attributes into diagnostics.
- Capture the exact command, time, branch/commit, status code, request ID, and first failure before changing configuration.
- Change one variable at a time and restore it before comparing another.

## One-minute triage

```powershell
git rev-parse --short HEAD
docker compose ps --all
curl.exe --silent --show-error --include http://localhost:8080/health
docker compose logs --since 5m app
docker compose logs --since 5m postgres
```

Classify before fixing:

| Observation | First boundary to inspect |
|---|---|
| App container absent/exited | startup config, migration diagnostics, container exit code |
| App running but health 503 | readiness state and live PostgreSQL probe |
| Health 200 but request 400 | client body/query contract; stable error reason |
| Request 503 with `Retry-After` | allowlisted database availability failure |
| Request 500 | unexpected application failure; correlate request ID with redacted logs |
| Slow query only | filters, time range, partition pruning, execution plan |
| Slow ingestion and aggregation | effective limits, saturation, storage, workload drift |
| Missing old rows | event-time retention cutoff and default-partition cleanup |

## Startup and migration failures

1. Inspect state without restarting repeatedly:

   ```powershell
   docker compose ps --all
   docker inspect logstream-project-app-1 --format '{{json .State}}'
   docker compose logs --no-color app
   docker compose logs --no-color postgres
   ```

   If Compose selected a different generated container name, copy it from `docker compose ps --format json`; do not guess.

2. Validate resolved Compose configuration without exposing environment secrets in shared output:

   ```powershell
   docker compose config --services
   docker compose config --images
   ```

3. Check database readiness from inside the PostgreSQL container:

   ```powershell
   docker compose exec postgres pg_isready --username postgres --dbname logstream
   ```

4. Inspect migration history metadata, not credentials:

   ```powershell
   docker compose exec postgres psql --username postgres --dbname logstream --command "TABLE logstream_migrations.schema_migrations;"
   ```

5. Interpret likely cases:

   - connection retry deadline: PostgreSQL unavailable, DNS/network issue, or bad role configuration;
   - checksum mismatch: an applied migration was edited; add a new migration rather than rewriting history;
   - runtime verification failure: grants/role initialization do not match the expected least-privilege model;
   - partition preparation failure: inspect the owner routine and default-partition overlap transaction.

Never “fix” a checksum mismatch by editing the history row. That destroys the evidence the checksum is designed to preserve.

## HTTP and validation failures

Capture headers and body together:

```powershell
$emptyBatch = '{"logs":[]}'
$emptyBatch | curl.exe --silent --show-error --include --request POST http://localhost:8080/logs --header "content-type: application/json" --data-binary '@-'
```

Check in order:

1. Is JSON syntactically valid? Malformed JSON has a distinct stable 400 response.
2. Is the top-level value an object with a `logs` array?
3. For each entry, check timestamp grammar/calendar/future bound, level, service, message, and flat scalar attributes.
4. Remember that U+0000 is rejected because PostgreSQL text/JSONB cannot represent it.
5. A mixed batch should return 200 with accepted count and rejected original indexes; an all-invalid or empty batch should return 400.
6. Copy `x-request-id` and search only that ID in application logs. Do not add the rejected payload to logs.

For query 400s, look for duplicate scalar parameters, duplicate attribute keys, invalid levels/timestamps, `until < since`, invalid limit, a cursor copied with different filters, or unsupported aggregation bucket/group values.

## Database availability and 503 responses

Read-only checks:

```powershell
docker compose ps
docker compose exec postgres pg_isready --username postgres --dbname logstream
docker compose exec postgres psql --username postgres --dbname logstream --command "SELECT now() AT TIME ZONE 'UTC' AS utc_now;"
```

Confirm the response includes a generic body and `Retry-After: 30`. Do not expose the underlying SQLSTATE or error message to the client. If testing a failure intentionally, use the contract harness because it owns interruption, diagnostics, restart, and cleanup; do not manually kill shared containers during someone else's run.

## Query and execution-plan debugging

Start with the public request: exact filters, range width, limit, response status, and duration. Then inspect storage shape:

```powershell
docker compose exec postgres psql --username postgres --dbname logstream --command "SELECT count(*) AS leaf_partitions FROM pg_inherits WHERE inhparent = 'logstream.logs'::regclass;"
docker compose exec postgres psql --username postgres --dbname logstream --command "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'logstream' ORDER BY indexname;"
```

Use the repository-owned plan tool for comparable evidence rather than pasting production values into ad hoc SQL:

```powershell
npm run build
npm run benchmark:query-plans
```

When reading a plan, ask:

- Did timestamp predicates prune unrelated partitions?
- Did a small page stop at `limit + 1`?
- Was the service/time index selected for a selective service filter?
- Is a sequential scan reasonable because the aggregation reads a large fraction of a leaf?
- Did sort/hash spill to temporary I/O?
- Are planning and execution times separated?

Do not add an index from intuition alone. Record a representative slow query, baseline plan/latency/write cost, one proposed index, the changed plan, end-to-end query benefit, ingestion/resource regression, and a retain/reject decision.

## Ingestion-performance regression

First prove workload comparability:

```powershell
git status --short --branch
docker compose config --services
docker compose config --images
docker version
docker compose version
node --version
npm --version
```

Keep shared output free of rendered connection strings. Compare the new report with [`performance/results/million-row-canonical-timestamp-confirmation.json`](performance/results/million-row-canonical-timestamp-confirmation.json):

- source commit and dirty state;
- measured/warm-up rows, seed, batch 250, concurrency four;
- application pool four and `LOG_LEVEL=info`;
- effective 0.5 CPU/256 MiB and 1 CPU/1 GiB controls;
- `fsync`, `synchronous_commit`, and `full_page_writes` still on;
- request status/failure/indeterminate counters;
- aggregation tick and scheduling-lag counters;
- exact row reconciliation and cleanup.

Never improve a result by excluding failures, weakening durability, raising limits, changing dataset, or quoting client attempt rate. If one intended variable changed, label it an experiment, run all correctness gates, and retain it only if end-to-end evidence improves without unacceptable latency/resource/security cost.

## Retention debugging

Inspect partitions and row ranges read-only:

```powershell
docker compose exec postgres psql --username postgres --dbname logstream --command "SELECT child.relname AS partition_name, pg_get_expr(child.relpartbound, child.oid) AS bounds FROM pg_inherits JOIN pg_class parent ON parent.oid = inhparent JOIN pg_class child ON child.oid = inhrelid JOIN pg_namespace ns ON ns.oid = child.relnamespace WHERE ns.nspname = 'logstream' AND parent.relname = 'logs' ORDER BY child.relname;"
docker compose exec postgres psql --username postgres --dbname logstream --command "SELECT min(timestamp), max(timestamp), count(*) FROM logstream.logs_default;"
```

Then check structured `Retention maintenance settled` fields:

- `status=skipped` usually means another session owned the advisory lock;
- a reached drop/delete budget means bounded backlog, not necessarily failure;
- repeated failures need the first redacted classification and database health;
- rows are expired by event timestamp, not `created_at`;
- shutdown may produce an aborted run by design.

Do not manually detach/drop partitions during a live demonstration. Retention DDL is centralized in hardened routines and should be exercised by integration tests or an isolated disposable stack.

## Safe small extension rehearsal

Example: add a derived `maintenanceActions` integer to the existing successful retention log. Define it as the sum of `partitionsCreated + partitionsDropped + defaultRowsDeleted`.

Why this is a safe teaching extension:

- no HTTP request or response changes;
- no schema, migration, index, role, or retention-action changes;
- no untrusted values or sensitive payloads enter logs;
- the value derives only from already validated counters;
- it is outside ingestion/query hot paths.

Implementation checklist:

1. State the exact invariant and files before editing.
2. Add the field only in `logResult()` in [`retention-service.ts`](../src/modules/retention/retention-service.ts).
3. Update the focused unit expectation in [`retention-service.test.ts`](../test/unit/retention-service.test.ts).
4. Check integer safety; each component is already a bounded/safe non-negative count.
5. Confirm no failure log starts exposing database errors or input data.
6. Run format, lint, typecheck, focused unit, all unit, build, integration, and contract tests.
7. Inspect the diff for unrelated changes and propose a Conventional Commit such as `feat(observability): report retention action count`.
8. Do not commit/push/merge without the authority required by the repository workflow.

If the exercise changes the API, storage, index inventory, durability, permissions, hot path, or benchmark configuration, it is no longer this “safe small extension”; stop and perform an architecture/performance/security review first.

## Verification and cleanup

After diagnosis or rehearsal:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run test:integration
npm run test:contract
docker compose ps --all
git status --short --branch
```

Expected evidence is explicit pass counts, contract cleanup confirmation, and only intended Git paths. If you started the ordinary local stack, stop it recoverably:

```powershell
docker compose down
```

Preserve the volume unless deletion was explicitly requested. Report what changed, what was measured, what remains uncertain, and the next safe experiment rather than declaring an unmeasured fix successful.
