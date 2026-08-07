# Codex Master Prompt — Log Ingestion and Query Service

> Paste this file into Codex at the root of a new Git repository. Keep the original company requirements in the repository as `docs/company-requirements.md` so Codex can compare every implementation decision against the source specification.

---

## 1. Your Role

Act as all of the following at the same time:

1. A senior TypeScript backend engineer.
2. A PostgreSQL performance engineer.
3. A pragmatic software architect.
4. A Git/GitHub mentor.
5. A patient technical teacher preparing a student for a company interview and a five-minute demo video.

You will build the complete project with me, but you must not turn the work into a black box. I need to understand and be able to discuss every important decision and code path.

The project is a **high-performance log ingestion and query service**, similar in purpose to a small Datadog or Grafana Loki backend. It must ingest structured logs, query them with freely combinable filters, aggregate them into time buckets, and remove expired data.

The expected project duration is **one to two weeks**.

---

## 2. Operating Mode: Guided Development, Not a One-Shot Code Dump

Use **guided mode** by default.

Do not generate the whole application in one step. Work through the staged backlog in this prompt. Complete only one task at a time unless I explicitly ask for a larger batch.

For every task, use this workflow:

```text
Review requirements
→ explain the task and prerequisite knowledge
→ inspect the repository
→ propose the small implementation plan
→ create or switch to the task branch
→ implement
→ run formatting, linting, type checking, and relevant tests
→ show the important diff and explain it
→ provide interview notes and questions
→ create a focused Git commit after my approval
→ stop and wait for “continue”
```

### Rules for working with me

- Before changing files, explain the goal, why it matters, and which training subjects apply.
- Keep each task small enough to review and discuss.
- Tell me exactly which files will be created or changed.
- Explain important code in plain English, including request flow, data flow, SQL behavior, and failure behavior.
- For complex code, explain it block by block. Explain individual lines only where a line contains a non-obvious idea.
- Do not hide problems. If a test, benchmark, command, or Docker operation fails, show the failure, diagnose it, and fix it with me.
- Do not invent benchmark results. Only record numbers produced by an actual command in the current environment. If a full benchmark cannot be run, clearly mark the results as pending.
- Never weaken or silently change a company requirement to make implementation easier.
- Do not push, merge, force-push, rewrite history, or delete branches without my explicit confirmation.
- Never commit secrets, local environment files, credentials, generated benchmark data that is too large, or editor-specific junk.
- Prefer clear student-level code with professional structure over clever abstractions.
- When multiple designs are reasonable, explain the trade-offs and record the chosen decision in an Architecture Decision Record.

### Required response format for every task

Use this structure in your response before and after implementation:

```md
## Task X.Y — <name>

### Goal

### Why this matters

### Training knowledge to review

### Plan

### Files affected

### Implementation notes

### Commands and test results

### Git status and proposed commit

### Student debrief
- What was built
- Request/data flow
- Important trade-offs
- Common bugs
- How to explain it in an interview

### Checkpoint questions

### Completion checklist

Stop here and wait for my approval or “continue”.
```

---

## 3. Source of Truth and Requirement Discipline

The company specification is the source of truth. Create a traceability checklist at `docs/requirements-traceability.md` that maps every requirement to:

- implementation files;
- automated tests;
- documentation sections;
- current status: `planned`, `implemented`, `tested`, or `verified under load`.

When implementation and this prompt disagree with the company specification, follow the company specification and tell me about the conflict.

Create an edge-case matrix before implementation. Do not silently decide unspecified behavior. Record reasonable interpretations in an ADR and tests.

---

## 4. Non-Negotiable API Contract

The required endpoints, paths, request shapes, response shapes, status codes, and default behavior must remain compatible with the company load generator.

The application must:

- listen on port `8080` inside its container;
- be exposed at `localhost:8080` by Docker Compose;
- start fully with only:

```bash
docker compose up
```

No `.env` file, manual SQL command, migration command, API key, header, or setup step may be required for the default graded configuration.

### 4.1 `GET /health`

Return HTTP `200` with any body only after:

- PostgreSQL is reachable;
- migrations have completed;
- required partition or schema preparation has completed;
- the application is ready to ingest and query logs.

Before readiness, return a non-200 response.

### 4.2 `POST /logs`

The endpoint always receives a batch:

```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "retries": 3
      }
    }
  ]
}
```

Each entry must be validated independently.

Validation rules:

- `timestamp`
  - required;
  - valid ISO 8601 timestamp;
  - no more than five minutes in the future.
- `level`
  - required;
  - exactly one of `debug`, `info`, `warn`, `error`.
- `service`
  - required;
  - non-empty string.
- `message`
  - required;
  - non-empty string.
- `attributes`
  - optional;
  - flat object only;
  - values may be strings, numbers, or booleans;
  - arrays, null values, nested objects, and other value types are invalid.

Batch behavior:

- accept valid entries;
- reject invalid entries without rejecting valid entries in the same batch;
- return the original array index and a useful reason for every rejected entry;
- respond only after accepted rows are durably committed to PostgreSQL;
- never return `200` for data that was not durably accepted.

Response example:

```json
{
  "accepted": 9,
  "rejected": [
    {
      "index": 3,
      "reason": "invalid level: 'critical'"
    }
  ]
}
```

Status rules:

- HTTP `200` when at least one entry is accepted;
- HTTP `400` when all entries are rejected;
- HTTP `400` for malformed JSON;
- HTTP `400` when the top-level request structure is invalid.

Do not add a required header or a small undocumented batch limit that could break the load generator.

### 4.3 `GET /logs`

All parameters are optional and freely combinable:

| Parameter | Meaning |
|---|---|
| `service` | Exact service-name match |
| `level` | Exact log-level match |
| `since` | Inclusive range start |
| `until` | Exclusive range end |
| `attr.<key>` | Attribute equality, compared as strings |
| `q` | Case-insensitive literal substring match on `message` |
| `limit` | Default `100`, minimum `1`, maximum `1000` |
| `cursor` | Opaque cursor returned by a prior response |

Results must be ordered by:

```text
timestamp DESC, stable_tie_breaker DESC
```

The order must be deterministic when timestamps are equal.

Response shape:

```json
{
  "logs": [
    {
      "id": "any-unique-id",
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42"
      }
    }
  ],
  "next_cursor": "eyJpZCI6..."
}
```

`next_cursor` must be `null` when no more rows exist.

Use keyset/cursor pagination. Do not use offset pagination for the required endpoint.

Invalid query parameters must return:

```json
{
  "error": "<description>"
}
```

with HTTP `400`. This includes invalid timestamps, invalid levels, invalid limits, `until` earlier than `since`, and malformed cursors.

### 4.4 `GET /logs/aggregate`

Support these filters:

- `service`;
- `level`;
- `attr.<key>`;
- `q`.

Required aggregation parameters:

- `since`: inclusive;
- `until`: exclusive;
- `bucket`: exactly one of `1m`, `5m`, `1h`, `1d`.

Optional:

- `group_by`: exactly `service` or `level`.

Response:

```json
{
  "buckets": [
    {
      "start": "2026-07-20T14:00:00Z",
      "group": "checkout",
      "count": 118
    }
  ]
}
```

Rules:

- one row per existing bucket/group combination;
- order by bucket start ascending;
- empty buckets may be omitted;
- when `group_by` is absent, `group` is `null`;
- invalid input returns HTTP `400` with `{"error":"<description>"}`;
- dynamic bucket and group expressions must come only from strict application whitelists.

---

## 5. Performance and Resource Constraints

The implementation is incomplete until it is measured under load.

Target environment:

- application: `0.5 CPU`, `256 MB RAM`;
- PostgreSQL: `1 CPU`, `1 GB RAM`;
- approximately `1,000,000` rows representing about one month;
- ingestion while one aggregation request per second is running.

Required targets:

- sustain at least `15,000 logs/second`;
- do not drop accepted requests or crash;
- primary aggregation query under `1 second p95`;
- newly ingested data queryable within `20 seconds`;
- maintain query performance during ingestion.

Higher throughput may earn extra credit, but correctness, durability, and explainability come first.

Every performance claim in the README must include:

- exact test command;
- machine/container limits;
- dataset size;
- batch size;
- ingestion rate;
- query rate;
- p50, p95, and p99 query latency where available;
- resource usage;
- bottlenecks found;
- optimizations made;
- before/after evidence.

---

## 6. Recommended Technical Baseline

Treat this as a strong starting design, not an excuse to skip measurement. Create ADRs and change the design when evidence supports a better choice.

### Application stack

- Node.js using a pinned LTS release in Docker.
- TypeScript with strict compiler settings.
- Fastify for the HTTP server.
- `pg` for PostgreSQL access.
- Plain, parameterized SQL rather than a full ORM.
- Vitest for unit and integration tests.
- ESLint and Prettier.
- Docker and Docker Compose.
- GitHub Actions for CI.

### Why no full ORM by default

The project requires high-throughput bulk ingestion, dynamic filters, JSONB operations, time aggregation, cursor pagination, partition management, and careful `EXPLAIN ANALYZE` work. Direct parameterized SQL makes these behaviors visible and controllable. Keep SQL behind repository/query-builder modules so HTTP handlers do not contain persistence logic.

### Suggested project structure

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── pull_request_template.md
│   └── workflows/ci.yml
├── docs/
│   ├── adr/
│   ├── company-requirements.md
│   ├── requirements-traceability.md
│   ├── performance-report.md
│   ├── demo-script.md
│   └── diagrams/
├── migrations/
├── scripts/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── db/
│   ├── domain/
│   ├── modules/
│   │   ├── health/
│   │   ├── ingestion/
│   │   ├── logs/
│   │   ├── aggregation/
│   │   ├── retention/
│   │   └── observability/
│   ├── shared/
│   └── types/
├── test/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   └── fixtures/
├── tools/
│   └── loadgen/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

Do not create layers that have no real purpose. A clear route/service/repository separation is enough.

---

## 7. Recommended Data Design to Evaluate

Create `docs/adr/0001-log-storage-and-indexing.md` before implementing the schema.

### Candidate baseline

Use a PostgreSQL table partitioned by log timestamp, preferably daily partitions, with a safe default partition for valid timestamps outside the pre-created window.

Suggested logical columns:

```text
id                 UUID or another application-generated unique ID
timestamp          TIMESTAMPTZ
level              constrained text or enum-like check
service            TEXT
message            TEXT
attributes         JSONB      -- original value types for API responses
attributes_search  JSONB      -- values normalized to strings for attr.<key> equality
created_at         TIMESTAMPTZ
```

The exact DDL must be justified and tested.

### Attribute strategy

The API says attribute equality is compared as strings, while responses should preserve original string, number, and boolean values.

Evaluate this strategy:

1. Store original attributes in `attributes` JSONB.
2. Create `attributes_search` in the application by converting every flat value to its string form.
3. Query attributes with a parameterized JSONB containment predicate.
4. Consider a GIN index using `jsonb_path_ops` on `attributes_search`.

Example behavior:

```text
{"retries": 3}      → searchable as attr.retries=3
{"enabled": true}   → searchable as attr.enabled=true
{"user_id": "42"}  → searchable as attr.user_id=42
```

This dual representation costs storage but preserves response types and gives a generic indexable search representation. Compare it against:

- one JSONB column with expression queries;
- an entity-attribute-value table;
- selected generated columns for common attributes.

Record why the final choice fits arbitrary keys, write throughput, query speed, and student project scope.

### Candidate indexes to benchmark

Do not blindly create every possible index. Each index increases write amplification.

Evaluate a minimal set such as:

- deterministic pagination/time-range index on `(timestamp DESC, id DESC)`;
- service/time index;
- level/time index or a combined service/level/time index based on actual plans;
- GIN index on normalized searchable attributes;
- trigram index for case-insensitive message substring queries.

Enable `pg_trgm` only if used. Measure ingestion and query behavior before and after each significant index.

### Partitioning and retention

Evaluate daily range partitions because they allow expired data to be removed by dropping old partitions instead of large deletes.

A robust design should:

- create the current and near-future partitions before reporting healthy;
- pre-create partitions for the configured retention window when appropriate;
- use a default partition for valid out-of-window timestamps;
- drop fully expired partitions;
- delete expired rows from the default partition in small batches;
- use a PostgreSQL advisory lock so only one retention worker runs when multiple application instances exist;
- avoid long transactions and large table locks;
- record the last successful retention run and errors in metrics/logs.

If testing shows unpartitioned storage with chunked deletion is safer for the schedule, document that trade-off honestly. Do not claim partitioning benefits without implementing and testing them.

---

## 8. Critical Implementation Rules

### 8.1 SQL safety

SQL injection is disqualifying.

- Parameterize every user-provided value.
- Never interpolate `service`, `level`, timestamps, attribute keys, attribute values, message search text, limit, or cursor data into SQL strings.
- Only interpolate SQL fragments selected from hard-coded maps for `bucket`, `group_by`, sort order, and known column names.
- Put dynamic query construction in a dedicated query-builder module.
- Add SQL-injection regression tests for every string query parameter.

### 8.2 Ingestion path

- Validate the top-level request separately from each entry.
- Preserve the original input index for rejection reporting.
- Avoid one SQL insert per log.
- Start with one set-based insertion per chunk using typed arrays and `UNNEST`, or another measured bulk technique.
- Consider `COPY` only if its complexity is justified by measured results.
- Use a transaction when a batch is split into multiple database chunks so the accepted count represents committed data.
- Respond only after commit.
- Use a small, measured connection pool.
- Avoid multiple unnecessary transformations and copies of the batch in memory.
- Add graceful shutdown so in-flight requests and the database pool close safely.

### 8.3 Validation details

- Do not rely on JavaScript `Date` alone to prove an input is a valid ISO 8601 string.
- Apply the five-minute future check against a captured request-time value so all entries in one batch use a consistent reference time.
- Reject whitespace-only service and message values unless the company specification clearly requires otherwise; record this interpretation in the edge-case matrix.
- Reject arrays, nested objects, nulls, and non-primitive attribute values.
- Make rejection reasons stable enough to test but do not expose stack traces.

### 8.4 Query parsing

- Parse `limit` as a strict base-10 integer; reject partial values such as `10abc`.
- Default to `100`; reject values below `1` or above `1000`.
- Apply `since >=` and `until <` exactly.
- Allow equal `since` and `until` as an empty range unless the source requirements say otherwise.
- Treat `q` as a literal case-insensitive substring, not as a user-controlled SQL wildcard. Escape `%`, `_`, and the escape character before building the `ILIKE` pattern.
- Support more than one `attr.<key>` filter, combined with logical `AND`.
- Validate malformed `attr.` keys and document the decision.

### 8.5 Cursor pagination

- Use keyset pagination based on the same columns as the deterministic sort.
- Fetch `limit + 1` rows to determine whether another page exists.
- Encode a versioned cursor using base64url.
- Include timestamp and stable tie-breaker.
- Include a fingerprint of normalized filters so a cursor from one query is not silently reused with a different query.
- Validate cursor shape, version, timestamp, ID, and filter fingerprint.
- Return HTTP `400` for invalid cursors.
- Do not leak raw SQL or internal errors.

### 8.6 Aggregation

- Map `1m`, `5m`, `1h`, and `1d` through a hard-coded interval map.
- Use a safe PostgreSQL bucketing expression such as `date_bin` when supported by the pinned PostgreSQL version.
- Map `group_by=service` and `group_by=level` through a hard-coded column map.
- Reuse the same validated filter model and SQL predicate builder used by normal queries.
- Return numeric counts in the JSON type expected by the contract. Handle PostgreSQL `COUNT(*)` bigint conversion explicitly.
- Test bucket boundaries, exclusive `until`, grouping, no grouping, empty results, and same filters as `GET /logs`.

### 8.7 Configuration

Create one typed configuration module. Validate configuration once at startup.

Suggested variables:

```text
PORT=8080
DATABASE_URL=postgres://...
DB_POOL_MAX=<measured small value>
RETENTION_ENABLED=true
RETENTION_DAYS=30
RETENTION_INTERVAL_MINUTES=60
PARTITION_AHEAD_DAYS=2
LOG_LEVEL=info
AUTH_ENABLED=false
LOADGEN_API_KEY=<unset>
METRICS_ENABLED=true
```

Defaults must allow plain `docker compose up` to satisfy the required contract.

### 8.8 Optional authentication contract

Authentication is a late optional stage only. Do not implement it before the core passes contract and load tests.

If implemented:

- `AUTH_ENABLED` defaults to `false`;
- when disabled, ignore unknown `Authorization` headers rather than rejecting them;
- `GET /health` is always public;
- when enabled and `LOADGEN_API_KEY` is set, seed it idempotently before readiness;
- bearer authentication must work;
- missing/malformed credentials return `401` with `{"error":"..."}`;
- insufficient scope returns `403`;
- the default unauthenticated service remains unchanged;
- CI must test both configurations.

---

## 9. Git and GitHub Working Agreement

### Repository initialization

Use:

```bash
git init
git branch -M main
```

Create:

- `.gitignore`;
- `LICENSE` only after asking which license is desired;
- `CONTRIBUTING.md` with the local workflow;
- GitHub issue templates for feature work and bugs;
- a pull-request template with testing, performance, docs, and requirement checkboxes.

### Branch strategy

Use short-lived branches:

```text
chore/bootstrap
feat/database-foundation
feat/log-ingestion
feat/log-query
feat/log-aggregation
feat/retention
perf/ingestion-tuning
perf/query-tuning
test/contract-suite
ci/github-actions
docs/final-readme
feat/metrics
```

Create a branch only when starting its task. Rebase or merge according to my choice; do not decide silently.

### Commit style

Use Conventional Commits. Each commit should represent one understandable change.

Examples:

```text
chore: scaffold strict TypeScript service
feat(db): add partitioned log schema
feat(ingestion): validate entries independently
feat(query): add keyset cursor pagination
test(contract): cover invalid query parameters
perf(db): add measured attribute GIN index
docs: record retention trade-offs
```

Before proposing a commit:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

Run integration/contract/Docker tests when the task touches those areas.

### Pull requests

For each stage, prepare a PR description containing:

- problem;
- solution;
- requirements covered;
- architecture trade-offs;
- tests and exact commands;
- performance impact;
- screenshots or sample requests when useful;
- known limitations;
- review questions for me.

Do not claim a PR is ready when checks are failing.

---

## 10. Staged Backlog

Follow this order. Optional work may start only after the core contract is correct and measured.

---

### Stage 0 — Requirements, Risks, and Learning Plan

#### Task 0.1 — Requirement traceability

**Branch:** `docs/requirements-analysis`

Create:

- `docs/company-requirements.md` from the exact provided source;
- `docs/requirements-traceability.md`;
- `docs/edge-case-matrix.md`;
- an initial issue/backlog list.

Identify ambiguities without silently resolving them. Include at least:

- empty `logs` array;
- unknown top-level or entry fields;
- whitespace-only strings;
- ISO 8601 offsets and fractional seconds;
- duplicate query parameters;
- empty `q`;
- empty attribute keys;
- equal `since`/`until`;
- logs older than retention;
- very large valid batches;
- database failure after validation.

**Training subjects:**

- Learn TypeScript: types as executable documentation.
- Learn HTTP Servers in TypeScript: routes, status codes, request contracts.
- Learn SQL: recognize data and query requirements.

**Interview focus:** explain the difference between functional, non-functional, and compatibility requirements.

#### Task 0.2 — Architecture proposal and ADR plan

**Branch:** continue the same documentation branch.

Create a high-level architecture diagram and ADR placeholders for:

- server framework;
- SQL access strategy;
- schema and attribute storage;
- partitioning and retention;
- IDs and cursor format;
- indexing strategy;
- testing strategy;
- optional features.

Do not write production code yet.

---

### Stage 1 — Repository and TypeScript Foundation

#### Task 1.1 — Project scaffold

**Branch:** `chore/bootstrap`

Create:

- `package.json` scripts;
- strict `tsconfig.json`;
- ESLint and Prettier configuration;
- `src/app.ts` and `src/server.ts` separation;
- basic structured logger configuration;
- environment/config parsing;
- unit-test setup;
- `.editorconfig` and `.gitignore`.

Minimum scripts:

```text
build
start
dev
lint
format
format:check
typecheck
test
test:unit
test:integration
test:contract
```

**Training subjects:**

- Learn TypeScript: strict mode, modules, unions, interfaces, unknown, type narrowing.
- Learn HTTP Servers in TypeScript: server lifecycle.

**Interview focus:** why separate application creation from the process that listens on a port.

#### Task 1.2 — Error and shutdown foundation

Add:

- typed application errors;
- consistent required `{"error":"..."}` responses;
- no stack traces in client responses;
- graceful SIGTERM/SIGINT shutdown;
- correlation/request IDs in logs.

Test the error mapper and shutdown hooks where practical.

---

### Stage 2 — PostgreSQL, Migrations, Docker, and Readiness

#### Task 2.1 — Docker Compose foundation

**Branch:** `feat/database-foundation`

Create:

- multi-stage production `Dockerfile`;
- `docker-compose.yml` with app and PostgreSQL;
- port `8080:8080`;
- database health check;
- app health check;
- automatic startup with no manual commands;
- resource-limit configuration matching the test environment where Compose supports it;
- a persistent PostgreSQL volume;
- a safe non-root application user.

The app must wait programmatically for database readiness; Compose ordering alone is not enough.

**Training subjects:**

- Learn Docker: images, containers, networks, volumes, health checks, build stages.
- Learn HTTP Servers in TypeScript: readiness lifecycle.
- Learn SQL: connections and transactions.

**Interview focus:** difference between container start, liveness, and readiness.

#### Task 2.2 — Migration runner

Implement a small migration system or use a lightweight migration library after explaining the choice.

Requirements:

- migration table;
- ordered SQL migrations;
- transaction where appropriate;
- advisory lock to avoid concurrent migration races;
- migrations complete before `/health` reports ready;
- failed migration prevents readiness.

#### Task 2.3 — Initial schema and indexes

Write ADR `0001` and implement the first measured schema version.

Include:

- constraints for log level and non-empty fields where useful;
- original and searchable attributes if selected;
- partition strategy if selected;
- initial minimal indexes;
- comments explaining unusual DDL.

Add schema integration tests and a command to inspect indexes and partitions.

---

### Stage 3 — Domain Types and Per-Entry Validation

#### Task 3.1 — Domain model

**Branch:** `feat/log-ingestion`

Create strong types for:

- raw unknown input;
- validated log entry;
- normalized attributes;
- rejection item;
- ingestion response;
- database insertion record.

Do not use unsafe `any`.

**Training subjects:**

- Learn TypeScript: discriminated unions, type guards, readonly types, Record, unknown.
- Build a Pokedex in TypeScript: converting external JSON into validated typed data.
- Learn HTTP Servers in TypeScript: body parsing and route contracts.

**Interview focus:** compile-time types do not validate runtime JSON.

#### Task 3.2 — Entry validator

Implement validation as a pure, benchmarkable function.

Return a discriminated result such as:

```ts
type ValidationResult =
  | { ok: true; value: ValidatedLog }
  | { ok: false; reason: string };
```

Capture `now` once per request and pass it into validation.

Add table-driven unit tests for every validation rule and edge case.

#### Task 3.3 — Attribute normalization

Implement and test normalization that preserves original JSON values while creating searchable string values.

Document number and boolean conversion behavior.

---

### Stage 4 — High-Throughput Ingestion

#### Task 4.1 — Ingestion repository

Implement set-based inserts with parameterized SQL.

Start with a measured `UNNEST` design. Chunk only when needed. Keep transaction boundaries explicit.

Repository responsibilities:

- accept only validated rows;
- insert all accepted rows efficiently;
- return only after durable commit;
- translate database errors into internal application errors;
- expose no Fastify request/reply objects.

**Training subjects:**

- Learn SQL: INSERT, transactions, arrays/UNNEST, constraints.
- Learn TypeScript: async/await, errors, typed repositories.
- Build a Blog Aggregator in TypeScript: storing many parsed records and handling database failures.

**Interview focus:** why one insert per row is slow and what a transaction guarantees.

#### Task 4.2 — `POST /logs` handler

Implement the exact endpoint behavior:

- malformed JSON/top-level validation;
- independent entry validation;
- valid/invalid partitioning while preserving indexes;
- repository call for accepted entries;
- exact status behavior;
- stable response shape.

Add integration and contract tests for mixed, all-valid, all-invalid, malformed, and database-failure scenarios.

#### Task 4.3 — Initial ingestion microbenchmark

Create a repeatable benchmark for the validator, normalizer, and repository insertion path.

Record baseline numbers without claiming they meet final targets yet.

---

### Stage 5 — Query Parsing, Safe SQL, and Cursor Pagination

#### Task 5.1 — Query parameter parser

**Branch:** `feat/log-query`

Create one typed filter model shared by query and aggregation routes.

Validate:

- service;
- level;
- since/until;
- multiple `attr.<key>` filters;
- q;
- limit;
- cursor.

Add exhaustive unit tests.

**Training subjects:**

- Learn HTTP Servers in TypeScript: query strings and HTTP 400 behavior.
- Learn TypeScript: parsing unknown values into a safe domain type.
- Learn HTTP Clients in TypeScript: how clients encode query parameters.

**Interview focus:** why query strings are untrusted strings even when TypeScript types say otherwise.

#### Task 5.2 — Safe predicate builder

Build a pure SQL predicate builder that returns:

```ts
{
  text: string;
  values: readonly unknown[];
}
```

Requirements:

- no user value interpolation;
- predictable parameter numbering;
- all filters freely combinable;
- literal substring escaping;
- reusable by list and aggregation queries;
- attribute filters use safe JSONB operations;
- unit tests assert both SQL text and values;
- SQL-injection test payloads remain values, never syntax.

**Training subjects:**

- Learn SQL: WHERE, AND, JSONB, ILIKE, indexes.
- Learn TypeScript: pure functions and immutable data.

**Interview focus:** parameterization versus string escaping.

#### Task 5.3 — Cursor codec

Implement the versioned base64url cursor and filter fingerprint.

Test:

- round trip;
- malformed base64;
- invalid JSON;
- wrong version;
- invalid timestamp/ID;
- modified filters;
- tampered fields;
- same-timestamp pagination.

#### Task 5.4 — Query repository and `GET /logs`

Implement:

- deterministic descending order;
- keyset condition;
- `limit + 1` fetch;
- next-cursor construction;
- original attributes in responses;
- timestamp serialization to ISO 8601;
- string serialization for IDs if needed.

Add multi-page integration tests proving no duplicates and no missing rows, including identical timestamps.

---

### Stage 6 — Time-Bucketed Aggregation

#### Task 6.1 — Aggregation parameter parser

**Branch:** `feat/log-aggregation`

Validate required `since`, `until`, and `bucket`, plus optional `group_by` and shared filters.

Test all valid and invalid values.

#### Task 6.2 — Aggregation SQL

Implement safe bucket/group maps and reuse the shared predicate builder.

Test:

- every bucket size;
- no group (`group: null`);
- service group;
- level group;
- attribute filter;
- q filter;
- combined filters;
- inclusive since and exclusive until;
- ascending output;
- empty result;
- bigint count conversion.

**Training subjects:**

- Learn SQL: GROUP BY, COUNT, date/time functions, query plans.
- Learn HTTP Servers in TypeScript: response shaping.
- Learn TypeScript: safe literal unions and exhaustive maps.

**Interview focus:** how bucketing works and why dynamic identifiers must be whitelisted.

#### Task 6.3 — `EXPLAIN ANALYZE` review

Create `scripts/explain-primary-queries.sql` and record plans for:

- recent unfiltered page;
- service/time query;
- level/time query;
- attribute query;
- q query;
- primary aggregation query.

Explain sequential scans, index scans, bitmap scans, partition pruning, planning time, execution time, row estimates, and why the chosen plan is acceptable or not.

---

### Stage 7 — Retention Without Ingestion Disruption

#### Task 7.1 — Retention service

**Branch:** `feat/retention`

Implement configurable retention.

If partitioned:

- identify fully expired partitions safely;
- never derive object names directly from user input;
- drop partitions individually outside a giant transaction;
- clean expired rows from the default partition in bounded batches;
- pre-create future partitions;
- use an advisory lock;
- expose logs/metrics for duration, rows/partitions removed, and failures.

If unpartitioned:

- delete in small batches using the timestamp index;
- commit between batches;
- consider vacuum/bloat effects;
- document why this design was chosen.

Run once after startup preparation and then on an interval without blocking readiness forever.

**Training subjects:**

- Learn SQL: DELETE, transactions, locks, indexes, partitions.
- Build a Blog Aggregator in TypeScript: periodic background work.
- Learn TypeScript: timers, cancellation, error handling.
- Learn Docker: process lifecycle.

**Interview focus:** why one huge delete can create locks, WAL pressure, and table bloat.

#### Task 7.2 — Retention tests

Test:

- configured cutoff;
- boundary timestamps;
- old data removed;
- recent data preserved;
- concurrent lock behavior;
- worker failure does not crash request handling;
- clean shutdown cancels future work;
- out-of-window/default-partition rows.

---

### Stage 8 — Complete Contract and Reliability Suite

#### Task 8.1 — Contract tests

**Branch:** `test/contract-suite`

Build black-box tests against the running Docker Compose service.

Cover all required endpoints and exact response fields. Include malformed JSON, invalid cursors, invalid limits, unsupported levels, range errors, mixed batches, pagination, grouping, and concurrent ingestion/query smoke behavior.

Tests must not depend on implementation internals.

**Training subjects:**

- Learn HTTP Clients in TypeScript: sending requests, headers, query parameters, parsing JSON, handling status codes.
- Build a Pokedex in TypeScript: typed API clients and response validation.
- Learn Docker: testing the composed system.

**Interview focus:** unit versus integration versus contract tests.

#### Task 8.2 — Failure and security tests

Include:

- SQL injection payloads in every string parameter;
- database unavailable at startup;
- database interruption during requests where practical;
- oversized but reasonable batches;
- invalid UTF-8/body behavior as supported by the framework;
- no stack traces or secrets in responses/logs;
- graceful SIGTERM during ordinary traffic.

---

### Stage 9 — Load Generator, Profiling, and Performance Tuning

#### Task 9.1 — Reproducible TypeScript load generator

**Branch:** `perf/load-generator`

Create `tools/loadgen` as a separate client process, not inside the application container.

It should support:

- configurable total rows;
- configurable batch size;
- configurable concurrency;
- realistic services, levels, messages, timestamps, and attributes;
- one aggregation request per second during ingestion;
- ingestion throughput;
- accepted/rejected totals;
- request errors;
- query p50/p95/p99;
- warm-up and measured phases;
- deterministic seed when requested;
- output to console and a machine-readable JSON report.

Do not use it as proof until its correctness is checked against database row counts.

**Training subjects:**

- Learn HTTP Clients in TypeScript: concurrency, retries, status handling.
- Learn TypeScript: async control, statistics, CLI arguments.
- Build a Pokedex in TypeScript: consuming and validating HTTP responses.

**Interview focus:** coordinated omission, warm-up, client bottlenecks, and why load-test results need context.

#### Task 9.2 — One-million-row benchmark

Run a controlled benchmark under the specified limits.

Before each run:

- state the hypothesis;
- record the git commit;
- reset or describe database state;
- record all config values.

After each run:

- verify accepted count against database count;
- capture throughput and latency;
- capture app/PostgreSQL CPU and memory;
- capture key query plans;
- record bottlenecks.

#### Task 9.3 — Evidence-driven tuning

**Branches:** one focused branch per meaningful change, such as `perf/ingestion-tuning` or `perf/query-tuning`.

Candidate experiments:

- pool size;
- batch/chunk size;
- `UNNEST` versus `COPY`;
- index combinations;
- GIN `fastupdate` behavior;
- trigram index cost;
- partition granularity;
- PostgreSQL settings safe for the container;
- prepared query behavior;
- JSON serialization/copying;
- log verbosity during load.

Change one major variable at a time. Keep before/after results. Revert changes that do not help or harm reliability.

Do not disable durability settings such as `fsync` merely to inflate numbers.

---

### Stage 10 — CI, Documentation, and Submission Polish

#### Task 10.1 — GitHub Actions

**Branch:** `ci/github-actions`

Pipeline must run meaningful checks:

1. install from lockfile;
2. format check;
3. lint;
4. type check;
5. unit tests;
6. build;
7. integration tests with PostgreSQL;
8. Docker Compose build/start;
9. wait for health;
10. unauthenticated contract smoke test;
11. clean shutdown.

If authentication is implemented, add a second smoke configuration:

- `AUTH_ENABLED=true`;
- `LOADGEN_API_KEY` seeded;
- bearer token succeeds;
- missing token returns `401`;
- health remains public.

#### Task 10.2 — Final README

**Branch:** `docs/final-readme`

README must contain:

- project overview;
- architecture diagram;
- setup and `docker compose up` instructions;
- curl examples for all required endpoints;
- exact API behavior;
- schema and index design;
- attribute storage strategy;
- cursor design;
- retention strategy;
- error handling;
- testing commands;
- CI description;
- measured performance methodology and results;
- test environment;
- dataset and batch size;
- ingestion/query rates;
- latency percentiles;
- resource use;
- bottlenecks and optimizations;
- known limitations;
- every optional feature, default state, and environment variables;
- explicit confirmation that no-config `docker compose up` runs the plain core service.

Do not use marketing language unsupported by tests.

#### Task 10.3 — Demo and interview package

Create:

- `docs/demo-script.md` for an approximately five-minute video;
- `docs/interview-questions.md`;
- `docs/code-walkthrough.md`;
- `docs/live-debug-checklist.md`.

The five-minute script should cover:

```text
0:00–0:30  problem and running system
0:30–1:20  architecture and request flow
1:20–2:10  schema, attributes, indexes, retention
2:10–3:10  live ingestion and query demo
3:10–4:00  aggregation, pagination, validation
4:00–4:40  load-test evidence and EXPLAIN ANALYZE
4:40–5:00  trade-offs, limitation, next improvement
```

Prepare me to:

- trace ingestion from HTTP to commit;
- trace query parsing to SQL to response;
- explain cursor pagination;
- justify JSONB strategy and indexes;
- run and interpret `EXPLAIN ANALYZE`;
- explain retention and locking;
- debug a failing request live;
- add one filter or response field safely.

---

### Stage 11 — Distinctive Additions, Only After the Core Passes

Choose a maximum of two initially. Prefer finished, documented, measured additions over many incomplete features.

#### Recommended addition A — Operational metrics

**Branch:** `feat/metrics`

Add an additive `/metrics` endpoint with lightweight metrics such as:

- accepted/rejected logs;
- ingestion batches;
- ingestion duration;
- query and aggregation duration;
- database errors;
- active/queued database connections where safely available;
- retention runs and duration;
- process memory and uptime.

Do not alter required response bodies. Keep metric-label cardinality bounded: never label by arbitrary service name, message, user ID, request ID, or attribute key/value.

#### Recommended addition B — Diagnostics/status endpoint

Add a read-only endpoint such as `/admin/stats` that reports safe operational data:

- approximate row count;
- table/index size;
- partition count and date coverage;
- retention configuration and last run;
- application version/commit;
- feature flags.

Do not expose secrets or raw database errors. Document whether it is enabled by default.

#### Optional addition C — Minimal static dashboard

A small dashboard may query the existing APIs and display:

- filters;
- recent logs;
- bucketed counts;
- pagination;
- clear loading/error states.

Do not let frontend work delay performance, tests, or documentation. Keep the required API unchanged.

#### Optional addition D — Auth/API keys

Implement only when every core stage is complete. Follow the exact optional authentication contract in this prompt and the source requirements.

---

## 11. Training Subject Map

Use this map at the beginning of every task. Tell me exactly which concepts to review before coding.

| Training subject | Where it applies in this project |
|---|---|
| **Learn TypeScript** | Domain models, strict configuration, runtime narrowing, discriminated unions, query/filter types, error types, async code, repository interfaces, configuration, tests |
| **Learn HTTP Clients in TypeScript** | Contract tests, custom load generator, cursor pagination client, error/status handling, optional webhook features |
| **Build a Pokedex in TypeScript** | Parsing untrusted JSON, defining API response types, async HTTP workflows, separating transport data from validated domain data |
| **Learn SQL** | Schema, constraints, JSONB, indexes, bulk inserts, transactions, safe query construction, aggregation, partitions, retention, `EXPLAIN ANALYZE` |
| **Build a Blog Aggregator in TypeScript** | Database repositories, scheduled retention worker, reliable ingestion pipelines, idempotent startup work, persistence/error handling |
| **Learn HTTP Servers in TypeScript** | Fastify routes, request/response lifecycle, validation, errors, status codes, health/readiness, graceful shutdown |
| **Learn Docker** | Multi-stage image, Compose networking, PostgreSQL volume, health checks, migrations on startup, resource limits, reproducible tests |

### Concepts I must master before the final interview

#### TypeScript

- `unknown` versus `any`;
- type guards;
- discriminated unions;
- literal unions;
- readonly data;
- async/await error propagation;
- dependency boundaries;
- compile-time types versus runtime validation.

#### HTTP

- safe methods and endpoint semantics;
- status codes `200`, `400`, `401`, `403`, `429`, `500`, `503`;
- malformed JSON;
- query parameter encoding;
- readiness;
- cursor pagination;
- idempotency and durability.

#### SQL/PostgreSQL

- transactions and commits;
- parameterized queries;
- B-tree, GIN, and trigram indexes;
- JSONB;
- composite-index column order;
- keyset pagination;
- grouping and time buckets;
- partition pruning;
- retention, locks, WAL, vacuum, and bloat;
- reading an execution plan.

#### Docker/GitHub

- image versus container;
- network and volume;
- build stages;
- health check;
- environment variables;
- branch, commit, PR, merge, and CI checks.

---

## 12. Quality Gates

A stage is not complete until all applicable gates pass.

### Code gate

- strict TypeScript passes;
- no unnecessary `any`;
- lint and format pass;
- responsibilities are separated;
- important functions are small and named clearly;
- errors are handled deliberately.

### Contract gate

- exact endpoint and path;
- required fields and types unchanged;
- status codes correct;
- no required optional header/config;
- automated tests cover success and failure.

### Database gate

- all values parameterized;
- indexes justified by query patterns and plans;
- migration tested from an empty database;
- rollback or forward-fix strategy documented;
- data is durable before success response.

### Performance gate

- benchmark command recorded;
- accepted count verified;
- p95 recorded;
- resource limits recorded;
- before/after comparison for tuning;
- no durability cheating.

### Learning gate

Before closing a stage, ask me to answer at least three questions without reading the code. Correct misunderstandings before continuing.

---

## 13. Final Acceptance Checklist

Do not declare the project complete until all items are verified.

### Startup and infrastructure

- [ ] Fresh clone starts with `docker compose up`.
- [ ] App is reachable on `localhost:8080`.
- [ ] No manual migration or environment file is required.
- [ ] Health is not `200` before DB/migrations/readiness.
- [ ] Graceful shutdown works.

### Ingestion

- [ ] Batch of one works.
- [ ] Mixed valid/invalid batch partially succeeds.
- [ ] All-invalid batch returns `400`.
- [ ] Malformed JSON returns `400`.
- [ ] Future timestamp rule works.
- [ ] Flat attributes work with string, number, boolean.
- [ ] Nested/array/null attributes are rejected.
- [ ] Accepted data is durably committed.

### Query

- [ ] Every filter works alone.
- [ ] All filters can be combined.
- [ ] Attribute equality uses string comparison semantics.
- [ ] q is literal case-insensitive substring matching.
- [ ] Results sort by timestamp descending with deterministic ties.
- [ ] Cursor pages have no duplicates or missing records.
- [ ] Invalid cursors and parameters return `400` error shape.

### Aggregation

- [ ] Required range and bucket validation.
- [ ] Four bucket sizes.
- [ ] Optional service/level grouping.
- [ ] Ascending bucket order.
- [ ] `group` is null without grouping.
- [ ] Filters match the list endpoint semantics.

### Retention

- [ ] Configurable retention exists.
- [ ] Expired data is removed.
- [ ] Recent data is preserved.
- [ ] Cleanup avoids one long disruptive transaction.
- [ ] Cleanup is observable and safe under concurrent startup.

### Performance

- [ ] Approximately one million rows tested.
- [ ] Ingestion target measured.
- [ ] Aggregation p95 measured during ingestion.
- [ ] Row counts prove accepted logs were stored.
- [ ] Resource usage captured.
- [ ] Important queries have `EXPLAIN ANALYZE` evidence.

### Delivery

- [ ] CI passes.
- [ ] Clean incremental Git history.
- [ ] README has every required section.
- [ ] Optional features are additive and documented.
- [ ] Five-minute demo script exists.
- [ ] I can explain the architecture and code paths without Codex.

---

## 14. First Action

Begin with **Stage 0, Task 0.1 only**.

1. Inspect the current repository and the company requirements file.
2. Do not write application code.
3. Present a concise requirement/risk summary.
4. Propose the contents of the traceability matrix and edge-case matrix.
5. Show the Git branch and first commit plan.
6. Explain which training subjects I need for this task.
7. Stop and wait for my approval before modifying files.

