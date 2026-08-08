# Codex Project Continuity & Handoff

## Purpose

This file allows any **new Codex chat/channel opened for this same project** to understand the current project state, workflow, rules, and next action without requiring the student to manually copy the previous conversation.

A new Codex channel must **not assume this file is perfectly current**. It must first inspect the repository and Git state, then use this file as continuity context.

---

# 1. Files to Read First

Before doing any work, read these files completely:

1. `AGENTS.md`
2. `CODEX_PROJECT_PROMPT.md`
3. `docs/company-requirements.md`
4. `docs/requirements-traceability.md` — if it exists
5. `docs/edge-case-matrix.md` — if it exists
6. `docs/backlog.md` — if it exists
7. `CODEX_HANDOFF.md`

Source-of-truth priority:

1. `docs/company-requirements.md` — authoritative company specification
2. `AGENTS.md` — repository working rules
3. `CODEX_PROJECT_PROMPT.md` — staged development, teaching, Git, testing, and interview workflow
4. Approved ADRs and project documentation
5. `CODEX_HANDOFF.md` — continuity/status information only

If any lower-priority file conflicts with the company specification, follow the company specification and explain the conflict.

---

# 2. Mandatory Start-of-Session Check

Every new Codex chat/channel must begin by inspecting the actual repository state.

Run and review:

```bash
git rev-parse --show-toplevel
git status
git branch --show-current
git log --oneline --decorate -10
git remote -v
```

Also inspect the repository tree.

Do **not**:

- initialize another Git repository;
- recreate work that already exists;
- assume the branch shown in this handoff is still current;
- assume a pull request has or has not been merged without checking the actual repository state.

If repository state differs from this file, trust the repository and update this handoff later.

---

# 3. Project Goal

Build a professional student-level **Log Ingestion and Query Service** in TypeScript and PostgreSQL.

The service is similar in concept to a simplified Datadog / Grafana Loki system.

The company evaluates:

- correctness;
- exact API compatibility;
- ingestion throughput;
- query/aggregation performance;
- PostgreSQL schema and index design;
- retention;
- reliability;
- security;
- Docker setup;
- CI;
- documentation;
- Git history;
- the student's ability to explain all important code and technical decisions.

Important performance targets include:

- at least 15,000 logs/second;
- approximately 1,000,000 stored log records;
- primary aggregation below 1 second p95;
- query performance maintained while ingestion is active;
- newly ingested data queryable within 20 seconds;
- one aggregation request per second during ingestion testing;
- application: 0.5 CPU / 256 MB RAM;
- PostgreSQL: 1 CPU / 1 GB RAM.

Never invent benchmark results.

---

# 4. Student Learning Goal

The AI may write the implementation, but the student must understand it well enough to explain and defend it in the company interview and approximately five-minute demo.

For every task:

1. Explain the goal before changing files.
2. Explain why the task matters.
3. Identify the training subjects involved.
4. Explain important technical decisions.
5. Explain important code after implementation.
6. Explain request/data flow.
7. Explain SQL and PostgreSQL behavior when relevant.
8. Explain performance implications.
9. Explain security implications.
10. Give likely interview questions and short model answers.
11. Ask the student checkpoint questions.
12. Stop for approval at the required checkpoint.

Training subjects:

- Learn TypeScript
- Learn HTTP Clients in TypeScript
- Build a Pokedex in TypeScript
- Learn SQL
- Build a Blog Aggregator in TypeScript
- Learn HTTP Servers in TypeScript
- Learn Docker

The implementation should be professional, but explanations must remain understandable for a trainee.

---

# 5. Development Workflow

Work on **one task at a time**.

The normal workflow is:

```text
Read current state
→ Review requirement IDs and edge cases
→ Explain task
→ Propose plan
→ Create/verify task branch
→ Implement only approved task
→ Run tests/checks
→ Explain implementation
→ Student checkpoint
→ Show Git status/diff
→ Propose commit
→ Wait for approval
→ Commit
→ Push
→ Pull request
→ Review/merge
→ Update main
→ Begin next approved task
```

Do not implement the entire project in one pass.

Do not silently move to the next task.

---

# 6. Git and GitHub Rules

Use short, reviewable branches.

Preferred branch examples:

```text
docs/requirements-analysis
docs/architecture-design
chore/bootstrap
feat/database-foundation
feat/log-ingestion
feat/log-query
feat/log-aggregation
feat/retention
test/contract-suite
perf/load-generator
ci/github-actions
docs/final-readme
```

Use Conventional Commit style where practical, for example:

```text
docs: add requirements traceability and project backlog
docs: add architecture decision records
chore: scaffold strict TypeScript service
feat: add log ingestion validation
feat: add cursor-based log querying
test: add API contract suite
perf: add reproducible load generator
```

Unless explicit approval has already been given for the current action, do not:

- commit;
- push;
- merge;
- force-push;
- rewrite history;
- delete branches.

Before proposing a commit, show:

```bash
git status
git diff --check
git diff --stat
```

Review the actual diff.

---

# 7. Architecture Rule

Do not treat earlier technical suggestions as automatically approved architecture.

Before major implementation, evaluate alternatives and document trade-offs.

For every major architecture decision:

1. Show at least two realistic alternatives.
2. Explain advantages.
3. Explain disadvantages.
4. Explain performance implications.
5. Explain complexity implications.
6. Explain operational implications where relevant.
7. Explain interview/demo implications.
8. Reference relevant requirement IDs and edge cases.
9. Recommend one option as **PROPOSED**.
10. Wait for approval before treating it as selected.
11. Record important approved choices in ADRs.

Major design areas include:

- server framework;
- application/module boundaries;
- PostgreSQL schema;
- arbitrary attribute storage;
- attribute string-search semantics;
- ID strategy;
- deterministic ordering;
- cursor/keyset pagination;
- indexing;
- partitioning;
- retention;
- bulk ingestion (`COPY`, `UNNEST`, or other measured alternatives);
- SQL/data-access strategy;
- migrations;
- connection pooling;
- Docker/runtime architecture;
- error handling;
- testing;
- performance architecture;
- security boundaries.

---

# 8. Requirement Classification Rule

Keep these concepts separate:

```text
COMPANY REQUIREMENT
→ DERIVED TECHNICAL REQUIREMENT
→ PROJECT DESIGN DECISION
→ IMPLEMENTATION
→ TEST / BENCHMARK EVIDENCE
```

Never present a project decision as if the company explicitly required it.

Use the existing traceability and edge-case documentation when available.

---

# 9. Performance Rule

Performance claims require evidence.

Do not write statements such as:

- "this will handle 15k logs/sec";
- "this index makes aggregation fast";
- "COPY is faster";
- "partitioning solves retention";

unless supported by actual measurements or clearly labeled as a hypothesis.

Performance work should include:

- exact environment;
- dataset size;
- batch size;
- concurrency;
- ingestion rate;
- query rate;
- p50/p95/p99 latency where relevant;
- PostgreSQL row-count reconciliation;
- resource usage;
- `EXPLAIN` / `EXPLAIN ANALYZE`;
- bottleneck found;
- change tested;
- before/after evidence.

---

# 10. Current Project Continuity Snapshot

This section is a convenience snapshot, not the source of truth.

Known completed work:

- Remote repository:
  `https://github.com/AbdalrhemDado/log-stream.git`
- Initial `main` commit created:
  `7a6ec79 add project instructions and requirements`
- The initial commit contains:
  - `AGENTS.md`
  - `CODEX_PROJECT_PROMPT.md`
  - `docs/company-requirements.md`
- Stage 0, Task 0.1 requirements analysis was completed.
- Branch created:
  `docs/requirements-analysis`
- Stage 0.1 documentation commit:
  `74d8a0a docs: add requirements traceability and project backlog`
- Stage 0.1 documentation files:
  - `docs/requirements-traceability.md`
  - `docs/edge-case-matrix.md`
  - `docs/backlog.md`
- Stage 0.1 was merged into `main` at commit:
  `f1a76ee`
- Stage 0, Task 0.2 architecture proposal and ADR plan was completed on branch:
  `docs/architecture-design`
- Stage 0.2 proposal commit:
  `cc049b210672352b6979d0c5472986863c8f0651 docs: propose log service architecture and ADR plan`
- Stage 0.2 architecture acceptance commit:
  `169f62bf82d4f5bca332885ed3e006422591e381 docs: accept log service architecture decisions`
- The proposal branch was pushed to:
  `origin/docs/architecture-design`
- The reviewer approved the architecture baseline and ADRs 0001 through 0012 on
  `2026-08-08`.
- The architecture proposal, ADR index, ADR records, traceability matrix, and
  edge-case matrix record that approval.
- Stage 0.2 was merged through pull request:
  `https://github.com/AbdalrhemDado/log-stream/pull/2`
- Stage 0.2 merge commit:
  `056b16cacefa8f1f595d652865fb6c0269b72d90 Merge pull request #2 from AbdalrhemDado/docs/architecture-design`

Current factual state at this checkpoint:

- Stage 1 was merged through pull request
  `https://github.com/AbdalrhemDado/log-stream/pull/3` using normal merge commit
  `3f1960d8640ba77602f58d41d014ec65dff92695`.
- The two Stage 1 commits are
  `4b05d9dec6dc4bc522d49bd9ce715a92847372cc chore: scaffold strict TypeScript service`
  and `7eceb267fa94dcf3b843959d7541ba271e83f29a feat: add error and shutdown foundation`.
- Branch: `feat/database-foundation`, created from the updated Stage 1 `main` at
  `3f1960d8640ba77602f58d41d014ec65dff92695`.
- Stage 2, Task 2.1 Docker/database-readiness foundation was committed and
  pushed on `feat/database-foundation` as
  `6b0672ad5ba4a5282d58698ab8090b795278a330 feat: add Docker and database readiness foundation`.
- Stage 2, Task 2.2 migration runner was committed and pushed on
  `feat/database-foundation` as
  `59c3f4967bfc57fd2aa60d63020321f1d8ac3ae7 feat: add transactional database migration runner`.
- Stage 2, Task 2.3 partitioned-schema implementation and validation are
  complete on the same branch; the Task 2.3 changes remain uncommitted and
  unpushed pending review.
- Stage 3 has not started and requires separate explicit authorization.
- No ADR acceptance is evidence that the design is implemented or that any
  performance target has been met.

---

# 11. Next Planned Task

The active task is Stage 2, Task 2.3 on `feat/database-foundation`. Review the
validated partitioned-schema diff and wait for explicit commit approval. Do not
commit or push Task 2.3 without that approval, and do not begin Stage 3.

The accepted architecture is the baseline for later implementation, but
evidence-gated details must still be decided from Stage 1 implementation,
security, database, and benchmark evidence as identified in the architecture
proposal and ADRs.

---

# 12. Continuity Update Rule

At the end of every approved task or meaningful Git milestone, update the **Current Project Continuity Snapshot** in this file.

Update only factual information such as:

- current completed stage/task;
- current branch;
- latest approved commit;
- whether a PR is open or merged;
- documents/code created;
- important approved decisions;
- next task.

Do not use this file to replace:

- company requirements;
- ADRs;
- traceability documentation;
- backlog;
- benchmark reports.

Those remain their own authoritative project documents.

Before modifying this handoff, show the proposed update and include it in the same documentation/housekeeping commit when appropriate.

---

# 13. New-Channel Opening Instruction

When this project is opened in a new Codex chat/channel, use this procedure:

```text
1. Read CODEX_HANDOFF.md.
2. Read all source-of-truth project files listed above.
3. Inspect Git and repository state.
4. Compare actual state with the handoff snapshot.
5. Report any mismatch.
6. State the current stage/task.
7. State the next allowed action.
8. Do not implement anything until the next task is confirmed or already approved.
```

The goal is that a new channel can continue the project safely without requiring the student to manually replay the previous conversation.
