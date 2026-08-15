---
name: harness-engineering-coding-agent
description: Portable operational workflow for AI coding agents. Use for software development tasks involving product discovery, PRD/specification, architecture, semantic specifications, coding, bugfixes, refactors, integrations, tests, auth, data, security, CI/CD, release, observability, replayability, rollback, evaluation and handoff. Também use para agentes de coding, desenvolvimento com IA, critérios de aceite, plano de testes, revisão, deploy seguro e medição pós-lançamento.
---

# Harness Engineering Coding Agent

Use this skill to guide an AI coding agent from **product intent** to **production impact** with disciplined harness engineering.

This skill is not a prompt for generating code faster. It is a portable operating workflow for building software with AI agents while preserving product clarity, engineering quality, verification, release safety, observability and learning.

It can be used by any coding agent that can read files, edit code, run commands and keep notes, including Claude Code, Codex, Cursor, Windsurf, Gemini CLI, OpenCode, local agents or internal company agents.

## Core principle

**Code is not software.**

Software includes requirements, architecture, data, user flows, security, tests, deployment, observability, maintenance and the process that keeps all of it coherent over time.

The agent must never treat a working local demo as production-ready software.

## Activation decision

If the user asks to build, modify, debug, refactor, test, release or evaluate software, first classify the request and choose the smallest workflow that protects quality without creating unnecessary process.

Use the full workflow only when the task has product ambiguity, user impact, production impact, user data, auth, integrations, release risk, security risk or multi-session complexity.

## Origin version check

At the start of a meaningful use, when internet access and Git or HTTP tooling are available, check whether this skill has a newer upstream version before changing the target project. The canonical source is:

```text
https://github.com/AndreAlmeidaDC/harness-engineering-coding-agent
```

Read the upstream `README.md` and compare the local copy against the upstream default branch using the lightest available method, such as `git fetch`, `git ls-remote`, direct raw file retrieval or repository metadata. If there are relevant differences, summarize what changed, identify potential impact on the current task and ask the user whether to update the local skill package before proceeding.

Never perform silent self-update. Never overwrite local edits without explicit user approval. If network access is unavailable, the repository cannot be reached or the task is too small to justify the check, continue with the local version and record the limitation in the final handoff when relevant. For the detailed protocol, read `references/version-check.md`.

## When to use

Use this skill when the task involves any of the following:

- product discovery for a new feature or application;
- PRD, specification, acceptance criteria or architecture definition;
- implementation of feature, bugfix, refactor, migration or integration;
- frontend plus backend plus data or auth;
- security, permissions, RLS, payments, credentials or personal data;
- CI/CD, release planning, feature flags, rollback or monitoring;
- evaluating whether an AI-generated change is good enough;
- designing semantic behavior contracts, agentic workflows, automations or AI-native systems;
- long-running tasks where another agent or human may need to resume later.

## When not to use the full workflow

Do not run the full workflow for one-off explanations, throwaway prototypes, small snippets, isolated edits that do not affect behavior or quick learning experiments.

Even then, keep Git safety, scope control and explicit done criteria.

## Execution modes

| Mode | Use when | Rule |
|---|---|---|
| `solo` | The task is small or medium, clear and low risk. | One agent performs the full loop with discipline. |
| `review-pair` | The task has medium risk, auth, data, security, business logic or release sensitivity. | One agent implements and another agent or separate session validates. |
| `squad` | The task is high-risk, long-running, product-critical or cross-functional. | Multiple roles are activated. Read `references/squad-mode.md`. |

The default is `solo`. Do not use `squad` just because it sounds impressive. Use it when the cost of coordination is lower than the cost of error.

## Non-negotiable rules

1. **No blind coding.** The agent must understand product intent or the existing spec before implementation.
2. **No giant context dump.** Load minimum sufficient context. Use documentation as a map, not as a landfill.
3. **No one-shot hero behavior.** Break work into small tasks and implement one task at a time.
4. **No premature victory.** Do not mark done because code compiles or a request returns `200`. Done requires acceptance criteria and relevant sensors.
5. **No test weakening.** Never delete, weaken or bypass tests to make the change pass. If a test is wrong, explain why and request or record approval.
6. **No silent scope creep.** Record extra work as follow-up. Do not implement outside the current task unless approved.
7. **No unsafe production action.** Production, credentials, payments, destructive database operations and user data require explicit approval.
8. **No untracked handoff.** Every meaningful run must leave enough state for another agent or human to continue.
9. **No unnecessary interrogation.** If an answer can be obtained from the codebase, existing docs, tests, logs, schemas or Git history, inspect those sources before asking the user.

## Coding hygiene rules

Keep implementation disciplined even when the task is small. These rules are intentionally lightweight and do not create an additional gate.

| Rule | Meaning | Practical check |
|---|---|---|
| **Think before coding** | Understand the intent, existing behavior and likely blast radius before editing. | Can the agent explain what it is about to change and why? |
| **Simplicity first** | Prefer the smallest design that satisfies the current contract. | Is there an easier solution with fewer moving parts? |
| **Surgical changes** | Every changed line should connect directly to the requested task or an approved prerequisite. | Did any line change outside the original scope? |
| **Verify every step** | Treat each slice as incomplete until a relevant sensor or explicit manual check has run. | What command, test, review or evidence proved this step? |

## Project files

Create lightweight versions only when the task requires them. Do not create process files for tiny edits that do not need them.

```text
AGENTS.md
.harness/STATE.md
.harness/CONTRACT.md
.harness/ACCEPTANCE_CRITERIA.md
.harness/TEST_PLAN.md
.harness/EVALUATION_REPORT.md
.harness/HANDOFF.md
.harness/OPEN_QUESTIONS.md
.harness/DECISION_GRILL.md
docs/product/PRODUCT_INTENT.md
docs/product/PRD.md
docs/product/METRICS_PLAN.md
docs/product/POST_LAUNCH_REVIEW.md
.harness/SEMANTIC_SPEC.md
docs/architecture/ARCHITECTURE.md
docs/decisions/DECISION_LOG.md
docs/release/RELEASE_PLAN.md
```

Keep `AGENTS.md` short. It should point to the right docs, commands and constraints, not contain the whole company brain.

## Artifact matrix

| Task type | Minimum artifacts | Optional artifacts |
|---|---|---|
| `quick-fix` | final summary with verification; `.harness/HANDOFF.md` if state matters | `.harness/EVALUATION_REPORT.md` |
| `feature` | `.harness/CONTRACT.md`, `.harness/ACCEPTANCE_CRITERIA.md`, `.harness/TEST_PLAN.md`, `.harness/HANDOFF.md` | `docs/product/PRD.md` |
| `product-feature` | `docs/product/PRODUCT_INTENT.md`, `docs/product/PRD.md`, `.harness/CONTRACT.md`, `.harness/HANDOFF.md` | `.harness/SEMANTIC_SPEC.md`, `docs/product/METRICS_PLAN.md` |
| `architecture` | `.harness/CONTRACT.md`, `.harness/SEMANTIC_SPEC.md`, `docs/architecture/ARCHITECTURE.md`, `docs/decisions/DECISION_LOG.md`, `.harness/HANDOFF.md` | `.harness/DECISION_GRILL.md`, `.harness/EVALUATION_REPORT.md` |
| `security-data` | `.harness/CONTRACT.md`, `.harness/ACCEPTANCE_CRITERIA.md`, `.harness/TEST_PLAN.md`, `.harness/EVALUATION_REPORT.md`, `.harness/HANDOFF.md` | `docs/decisions/DECISION_LOG.md` |
| `release` | `docs/release/RELEASE_PLAN.md`, `.harness/EVALUATION_REPORT.md`, `.harness/HANDOFF.md` | `.harness/SEMANTIC_SPEC.md` when replay/auditability matters, `docs/product/POST_LAUNCH_REVIEW.md` |
| `investigation` | `.harness/STATE.md`, `.harness/EVALUATION_REPORT.md` or investigation notes, `.harness/HANDOFF.md` | `.harness/OPEN_QUESTIONS.md`, `.harness/DECISION_GRILL.md` |

## Workflow

### Phase 0: classify the task

Classify the request before acting. Use one or more of these labels:

- `quick-fix`: simple correction, low risk;
- `feature`: new behavior or UI;
- `product-feature`: feature with product ambiguity;
- `architecture`: structural decision or cross-cutting change;
- `semantic-system`: behaviors, guarantees, constraints, agentic workflows, automations, replayability, auditability or AI-native runtime concerns;
- `security-data`: auth, permissions, secrets, RLS, payments or personal data;
- `release`: deployment, flags, rollback, observability;
- `investigation`: bug diagnosis, research, logs or incident.

Then choose execution mode: low risk uses `solo`, medium risk uses `review-pair`, and high-risk or long-running work uses `squad`.

### Phase 1: product intent gate

Before spec or code, answer:

- What problem are we solving?
- Who has this problem?
- Why now?
- What happens if we do not build it?
- What is the smallest valuable version?
- What should not be built now?
- How will we know if it worked?

If answers are missing for product-relevant work, read `references/product-engineering-discovery.md` and create or update the needed product intent artifacts.

### Phase 2: specification gate

For any feature with more than trivial scope, create or update the contract, acceptance criteria and test plan. Use `references/prd-specification-builder.md` when the product, role, flow, architecture or acceptance criteria are not clear.

The spec must distinguish confirmed facts, decisions, assumptions, open questions and out-of-scope items. Every meaningful requirement must have an ID, for example `BUS-001`, `USER-001`, `AUTH-001`, `DATA-001`, `UI-001`, `SEC-001`, `NFR-001`, `REL-001` or `MET-001`.

### Phase 2.2: decision grill gate

Use this gate when the plan, PRD, architecture, release path or semantic behavior has unresolved branches. Create `.harness/DECISION_GRILL.md` from `templates/DECISION_GRILL.md` when ambiguity could cause rework, unsafe implementation or misaligned expectations.

The agent must walk the decision tree one dependency at a time. For each critical question, provide a recommended answer and confidence level. If the answer can be discovered by inspecting the codebase, documentation, tests, logs, schemas, configuration or Git history, inspect those sources instead of asking the user. Ask the user only when the missing answer blocks safe progress or requires a product/business decision.

### Phase 2.5: semantic specification gate

Use this gate for `architecture`, `semantic-system`, agentic workflows, automations, distributed behavior or AI-native systems. Read `references/semantic-system-design.md` and create or update `.harness/SEMANTIC_SPEC.md` when behavior, guarantees, constraints, events, state, replay, auditability or observability are central to the task.

The agent should describe behaviors before files and functions. Prefer plain language, but use lightweight behavior blocks when that makes the contract clearer. The goal is not to impose a DSL or advanced stack; the goal is to prevent duplicated logic, architectural drift and hidden assumptions.

For structural decisions, perform a proportionate state-of-the-art review. Compare the simplest conventional approach with any advanced option such as state machines, workflow engines, event sourcing, actor models, policy engines, graph storage, vector retrieval, CQRS or transactional outbox. Choose the smallest design that preserves the required guarantees.

### Phase 3: context loading

Load only context relevant to the task. Recommended order:

1. `AGENTS.md`
2. `.harness/STATE.md`
3. `.harness/CONTRACT.md`
4. relevant PRD, spec and test plan
5. relevant architecture docs
6. files directly involved in the task
7. recent Git history if needed

Do not load every document just because it exists.

### Phase 4: Git safety gate

Before modifying files, check repository state with the equivalent of:

```bash
git status
git branch --show-current
git log --oneline -5
```

If the working tree is dirty, identify whether changes belong to the user. Do not overwrite them. Prefer a branch or worktree for non-trivial work.

### Phase 5: task breakdown

Break the work into small tasks. Each task must include task ID, linked requirement IDs, files likely affected, expected behavior, verification method, rollback risk and done criteria.

If there are more than five steps or unclear dependencies, create `.harness/TASKS.md`.

### Phase 6: implementation loop

For each task:

1. restate the task;
2. make minimal changes;
3. run relevant sensors;
4. inspect failures;
5. correct;
6. update progress;
7. stop after the task is done.

Do not mix unrelated tasks in the same loop.

**Prefer test-first when behavior is specifiable.** When the task involves testable logic whose expected behavior can be derived from the contract or acceptance criteria, write the test before the implementation: encode the expected behavior in a test that fails first, make the smallest change that passes it, then refactor under the protection of that test (red-green-refactor). A passing test should be evidence that the contract is met, not only that the code runs. This is optional and conditional, not a gate. Skip it for exploratory work, throwaway prototypes, or behavior and UI that cannot yet be specified.

If the agent starts drifting from the contract during a long task, for example reintroducing out-of-scope behavior, contradicting the data model, forgetting the agreed user flow or losing earlier decisions as the context window fills, stop and re-anchor before continuing. Re-paste or re-read the governing artifacts, normally `.harness/CONTRACT.md`, the data model and the acceptance criteria, then resume from the restated task. Re-anchoring is cheaper than letting an agent rebuild on a drifted understanding. For the detailed trigger and recovery steps, read `references/context-reanchoring.md`.

### Phase 7: feedback sensors

Use computational sensors first: unit tests, integration tests, e2e tests, lint, typecheck, build, static analysis, schema validation, migration dry-run, replay/audit checks, accessibility checks and security scans when applicable.

Use inferential sensors second: AI review, architecture critique, UX critique, security reasoning and requirement coverage review.

Inferential sensors are useful, but they are not a substitute for deterministic checks.

If no automated test exists, create the smallest relevant verification path or document why verification is currently manual.

Never report verification as complete with generic wording. Always include exact commands, exact outcomes and remaining blind spots.

### Phase 7.5: harness telemetry and learning loop

For meaningful work, capture evidence about whether the harness itself was sufficient, not only whether the code changed. Record which context was used, which gates were activated or skipped, which sensors produced useful signal, which blind spots remain and whether the run revealed a candidate improvement to the skill, templates or checklists.

Harness improvement candidates are recommendations, not permission to mutate the skill silently. Treat the harness as operational software: improvements must preserve or strengthen traceability, consent, verification quality, safety and handoff continuity.

When the agent makes a mistake that a durable rule could have prevented, prefer writing the rule over only fixing the instance. A correction in the current conversation fixes this run; a rule recorded in the project's agent-instruction file (for example `AGENTS.md`) or in a relevant artifact fixes every future run. This applies to recurring mistakes, not one-off slips. Keep such rules specific and falsifiable, and subject them to the same scope and safety constraints as any other change.

### Phase 8: evaluation report

Create or update `.harness/EVALUATION_REPORT.md` for meaningful work. Include what changed, which requirements were covered, commands run, pass/fail result, unresolved risks, assumptions made, files changed, harness telemetry, remaining blind spots and follow-up tasks.

### Phase 9: release gate

If the change will reach users, production, customer data, integrations or operational workflows, read `references/release-measurement-loop.md`.

Answer these release questions:

- How will this reach users?
- Is there a feature flag?
- Is there rollback?
- Who owns the release?
- What logs, metrics, traces, audit events and replay evidence are needed?
- What is the blast radius?
- What is the post-launch review date?

### Phase 10: handoff

End every meaningful run with `.harness/HANDOFF.md`. Include current state, completed work, pending work, blocked items, commands already run, files changed, risks and recommended next action.

## Review-pair handoff

When using `review-pair`, the implementation agent must provide requirement IDs addressed, files changed, commands run, known risks, verification gaps and suggested review focus.

The evaluation agent must not assume correctness from the implementation summary. It must verify against the contract and inspect changed files.

Whenever work is judged against a rubric, acceptance criteria or a quality bar, the agent that judges must not be the same agent, in the same context, that produced the work. An author scoring its own output is subject to self-preferential bias and tends to pass it. This is the core reason `review-pair` exists: separate the producing context from the judging context. When a true second agent or session is unavailable, make the check deterministic instead (tests, lint, schema validation) rather than relying on the author's self-assessment against the rubric.

For ambiguous plans, the reviewer may act as a critical interviewer: identify the weakest assumptions, walk the decision tree, answer codebase-discoverable questions directly and ask only one blocking user question at a time.

## Definition of done

A task is done only when product intent is clear enough for the current scope, spec or contract exists when needed, all acceptance criteria for the task were addressed, relevant sensors were executed, failures were fixed or explicitly recorded, no user changes were overwritten, no test was weakened without approval, state and handoff were updated, and release and measurement plan exist when users are affected.

## Anti-patterns

Stop and correct course if you detect vibe coding by prompt accumulation, implementation before product intent, PRD with no acceptance criteria, acceptance criteria with no test plan, giant `AGENTS.md` as memory landfill, agent judging its own work without sensors, code compiling but behavior not validated, tests deleted to pass, feature launched without rollback, no owner for post-launch behavior, or logs, metrics, traces or audit events added only after an incident, or architecture chosen before behavior and guarantees are explicit.

## Output format for agent responses

At the end of an execution, respond with:

```text
Summary
- What changed

Verification
- Commands/sensors run
- Results
- Remaining blind spots

Risks
- Known risks or assumptions
- Scope check: did any changed line fall outside the original user-approved scope?

Files changed
- List

Next action
- Recommended next step
```

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-06-04 | 12:17 GMT-3 | Added harness telemetry, regression-free harness improvement rules and stronger shared-state continuity inspired by the Code as Agent Harness paper. |
| 2026-05-28 | 13:00 GMT-3 | Reworked as a portable skill for any AI coding agent, added YAML frontmatter, activation heuristics, artifact matrix, review-pair handoff and stronger verification rules. |
| 2026-05-29 | 05:50 GMT-3 | Added semantic specification gate, state-of-the-art review guidance, replay/auditability checks and semantic-system classification inspired by VibeCoding state-of-the-art-driven development. |
| 2026-05-29 | 06:05 GMT-3 | Added decision grill gate and no-unnecessary-interrogation rule inspired by the `grill-me` critical interview pattern. |
| 2026-06-01 | 18:45 GMT-3 | Added lightweight coding hygiene rules and an origin version check protocol with explicit user consent before any skill update. |
| 2026-06-12 | 12:00 GMT-3 | Added a mid-run context re-anchoring step to the implementation loop, with a matching checklist item and `references/context-reanchoring.md`, generalizing a context-recovery practice from Vinícius Lana / AI Coders Academy. |
| 2026-06-13 | 12:00 GMT-3 | Hardened two existing rules: capture recurring mistakes as durable project rules (Phase 7.5), and require that rubric-based judging is never done by the authoring context (review-pair). |
| 2026-06-24 | 12:00 GMT-3 | Added an optional, conditional test-first (red-green-refactor) directive to the implementation loop, with a matching checklist item. Test-first is a standard XP engineering practice, not a gate. |
