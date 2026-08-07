# Codex Repository Instructions

Before starting any task, read:

- `CODEX_PROJECT_PROMPT.md`
- `docs/company-requirements.md`

`docs/company-requirements.md` is the authoritative company specification.

`CODEX_PROJECT_PROMPT.md` defines:

- the staged development workflow;
- Git and GitHub practices;
- teaching and explanation requirements;
- testing and quality gates;
- performance-validation requirements;
- interview and demo preparation.

## Core Working Rules

Work on only one task at a time.

Do not implement the whole project in one pass.

Before changing files:

1. Explain the task.
2. Explain why it matters.
3. List the relevant training subjects.
4. List the files that will change.
5. Present a small implementation plan.
6. Identify important architecture, database, performance, or security decisions involved.

After implementation:

1. Run relevant tests and checks.
2. Report the actual results.
3. Explain the important code and data flow.
4. Give interview notes and checkpoint questions.
5. Show Git status and propose a Conventional Commit.
6. Stop for approval.

Never invent benchmark results.

Never weaken the company API contract.

Never commit, push, merge, force-push, rewrite history, or delete branches without explicit approval.

## Architecture and System Design

During the architecture stage, spend extra attention on system design before implementation.

Prepare and explain:

1. High-level system architecture.
2. Component/module architecture.
3. Request and data flow for ingestion.
4. Request and data flow for querying.
5. Request and data flow for aggregation.
6. Database schema design.
7. Attribute storage alternatives and the selected approach.
8. Index design and why each index exists.
9. Partitioning strategy.
10. Retention architecture.
11. Cursor pagination design.
12. Error-handling architecture.
13. Docker/deployment architecture.
14. Performance strategy for 15,000+ logs/second.
15. Expected bottlenecks and how they will be measured.

Use diagrams where helpful.

For every major decision:

- show at least two reasonable alternatives;
- explain advantages and disadvantages;
- recommend one;
- explain it in student-friendly language;
- record important decisions in ADRs when appropriate.

Do not implement major architecture decisions until they have been explained and approved.

## Teaching Requirements

The AI may write the code, but the student must understand and be able to discuss it.

For every task:

- explain important TypeScript concepts;
- explain relevant HTTP concepts;
- explain relevant SQL/PostgreSQL concepts;
- explain Docker/Git/GitHub concepts when involved;
- explain performance implications;
- explain security implications;
- connect the task to the company training topics;
- provide likely interview questions and short model answers;
- ask the student to explain the completed work in their own words.

Keep explanations professional, practical, and understandable for a trainee.

## Source of Truth

If `CODEX_PROJECT_PROMPT.md` conflicts with `docs/company-requirements.md`:

1. Follow `docs/company-requirements.md`.
2. Explain the conflict.
3. Do not silently change, reinterpret, or weaken a company requirement.

The required API contract, Docker startup behavior, resource limits, performance targets, load-generator compatibility, CI requirements, and deliverables from the company specification are mandatory.

## First Task

Begin with:

`Stage 0, Task 0.1 — Requirement traceability`

Do not write application code during the first task.

For the first task:

1. Inspect both instruction files and the repository.
2. Summarize the requirements and major risks.
3. Identify ambiguous or underspecified decisions.
4. Propose a requirements traceability matrix.
5. Propose an edge-case matrix.
6. Propose the Git branch and commit plan.
7. List the training topics the student should review.
8. Ask checkpoint questions.
9. Stop and wait for approval.
