# PRD Specification Builder

Use this reference to transform product intent into an executable PRD, contract, acceptance criteria and test plan.

This module exists to create **feedforward context** for coding agents. The goal is not documentation theater. The goal is to produce enough structured context for implementation and verification to be safe.

## When to load this reference

Load this file when the task has more than trivial feature scope, unclear roles, unclear flows, architecture implications, business rules, security constraints, data model changes, integrations, or acceptance criteria that are not testable yet.

## Inputs

- Product idea or user request.
- Product intent, if available.
- Target users and roles.
- Stack and architecture constraints.
- Known business rules.
- Known exclusions.
- Existing product, architecture or API documentation.

## Outputs

| File | Purpose |
|---|---|
| `docs/product/PRD.md` | Product and behavior specification. |
| `.harness/CONTRACT.md` | Execution contract for the current task. |
| `.harness/ACCEPTANCE_CRITERIA.md` | Testable acceptance criteria tied to requirement IDs. |
| `.harness/TEST_PLAN.md` | Verification strategy and required sensors. |
| `.harness/OPEN_QUESTIONS.md` | Questions that block or influence scope. |
| `docs/decisions/DECISION_LOG.md` | Decisions that affect architecture, scope or behavior. |

## Required PRD sections

1. Metadata and version control.
2. Product overview.
3. Target users and roles.
4. Business goals and KPIs.
5. User journeys.
6. Functional requirements.
7. Non-functional requirements.
8. Data model and domain objects.
9. API and integration requirements.
10. Auth, permissions and security.
11. UI and design system notes.
12. MVP scope.
13. Out of scope.
14. Risks and mitigations.
15. Acceptance criteria.
16. Test strategy.
17. Open questions.
18. Decision log.

## Requirement ID standard

Use stable IDs so implementation, tests and evaluation can refer to the same requirement.

| Prefix | Use for |
|---|---|
| `BUS` | Business requirements and business rules. |
| `USER` | User roles, journeys and user-facing behavior. |
| `AUTH` | Authentication, authorization and permissions. |
| `DATA` | Data model, storage, migrations and data integrity. |
| `API` | API contracts and integrations. |
| `UI` | Interface and interaction requirements. |
| `SEC` | Security, privacy, secrets and abuse prevention. |
| `NFR` | Performance, accessibility, reliability and maintainability. |
| `REL` | Release, rollout, rollback and operational requirements. |
| `MET` | Metrics, analytics, observability and learning. |

## Rules

Every requirement must have an ID. Acceptance criteria must be testable. Open questions must not be hidden inside prose. Assumptions must be labeled. Exclusions must be explicit. Do not generate architecture that contradicts existing architecture docs.

## Testability standard

Each acceptance criterion should be written so another agent or human can answer: **how would I prove this is true?** If the answer is unclear, rewrite the criterion.

A good acceptance criterion includes the actor, precondition, action, expected behavior and verification method.

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-28 | 13:10 GMT-3 | Converted from subskill to portable reference and added requirement ID and testability standards. |
