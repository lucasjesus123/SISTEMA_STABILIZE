# Execution Checklist

Use this checklist before closing any meaningful coding-agent task.

## Classification

| Check | Status | Notes |
|---|---|---|
| Task type was classified as `quick-fix`, `feature`, `product-feature`, `architecture`, `security-data`, `release` or `investigation`. |  |  |
| Execution mode was selected as `solo`, `review-pair` or `squad`. |  |  |
| Risk level and production impact were considered. |  |  |

## Product and specification

| Check | Status | Notes |
|---|---|---|
| Product intent is clear enough for the current scope. |  |  |
| Open questions are recorded instead of hidden. |  |  |
| Requirements have stable IDs where relevant. |  |  |
| Acceptance criteria are testable. |  |  |
| Out-of-scope items are explicit. |  |  |

## Semantic design

| Check | Status | Notes |
|---|---|---|
| `.harness/SEMANTIC_SPEC.md` was created or explicitly deemed unnecessary for the task risk. |  |  |
| Behaviors, guarantees, constraints, events, state and failure modes are explicit when relevant. |  |  |
| Replay, auditability and observability requirements were considered for agentic or AI-native behavior. |  |  |
| State-of-the-art review was proportionate and did not introduce unnecessary architecture. |  |  |

## Git safety

| Check | Status | Notes |
|---|---|---|
| `git status` was checked before changes. |  |  |
| Current branch was identified. |  |  |
| User changes were not overwritten. |  |  |
| Risky or non-trivial work used a branch or worktree when appropriate. |  |  |

## Implementation

| Check | Status | Notes |
|---|---|---|
| Work was broken into small tasks. |  |  |
| Each change maps to requirement IDs or clear task objectives. |  |  |
| Each changed line is defensible as part of the original user-approved scope or an approved prerequisite. |  |  |
| Scope did not expand silently. |  |  |
| If the agent drifted from the contract during the task, it re-anchored on the governing artifacts before continuing. |  |  |
| When behavior was specifiable, the test was written before the implementation (test-first), or test-first was explicitly deemed unnecessary for the task. |  |  |
| Tests were not weakened or bypassed. |  |  |

## Verification

| Check | Status | Notes |
|---|---|---|
| Relevant unit/integration/e2e tests were run or explicitly marked unavailable. |  |  |
| Lint/typecheck/build were run when relevant. |  |  |
| Security/data/auth checks were run when relevant. |  |  |
| Manual verification was described when automation was not available. |  |  |
| Remaining blind spots were documented. |  |  |

## Release and measurement

| Check | Status | Notes |
|---|---|---|
| Release plan exists when users or production are affected. |  |  |
| Rollback path is explicit. |  |  |
| Logs, metrics or alerts are defined when behavior is user-facing or operational. |  |  |
| Post-launch learning or review is defined when relevant. |  |  |

## Handoff

| Check | Status | Notes |
|---|---|---|
| `.harness/EVALUATION_REPORT.md` exists or final response includes equivalent evidence. |  |  |
| `.harness/HANDOFF.md` exists for meaningful work. |  |  |
| Files changed and commands run are listed. |  |  |
| Next action is clear. |  |  |

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-28 | 13:20 GMT-3 | Updated checklist to match the portable harness workflow and artifact matrix. |
| 2026-05-29 | 05:55 GMT-3 | Added semantic design checks for behavior contracts, replay, auditability, observability and proportional architecture review. |
| 2026-06-01 | 18:45 GMT-3 | Added explicit surgical-change scope check aligned with the lightweight coding hygiene rules. |
| 2026-06-12 | 12:00 GMT-3 | Added a context re-anchoring check to the Implementation section. |
| 2026-06-24 | 12:00 GMT-3 | Added an optional test-first check to the Implementation section. |
