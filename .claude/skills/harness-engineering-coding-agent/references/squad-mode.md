# Squad Mode

Use squad mode when the cost of a bad decision is higher than the cost of coordination.

A squad is optional. The right default is a **skill with squad capability**, not a permanent squad for every task.

## Activate squad mode when

Use squad mode if at least two conditions are true:

- multiple user roles or business flows are involved;
- product intent is unclear;
- frontend, backend, data and auth are all involved;
- security, payments, permissions, RLS or personal data are involved;
- release affects real users;
- the task will span more than one session;
- rollback would be hard;
- measurement and adoption matter;
- architecture may constrain future work.

## Do not activate squad mode when

Do not activate squad mode when the task is a small bugfix, scope is clear and local, only one file changes, no data/auth/security/release risk exists, or coordination cost is higher than error risk.

## Roles

| Role | Owns the question | Main outputs |
|---|---|---|
| Product Strategist | Why build this? | `docs/product/PRODUCT_INTENT.md`, `docs/product/METRICS_PLAN.md`, `.harness/OPEN_QUESTIONS.md` |
| Spec Architect | What exactly must be built? | `docs/product/PRD.md`, `.harness/CONTRACT.md`, `.harness/ACCEPTANCE_CRITERIA.md`, `.harness/TEST_PLAN.md` |
| System Architect | What structure keeps this maintainable? | `docs/architecture/ARCHITECTURE.md`, `docs/decisions/DECISION_LOG.md`, architecture constraints |
| Implementation Agent | How do we build the smallest correct slice? | Code changes, task notes, command log |
| Evaluation Agent | Is it good enough? | `.harness/EVALUATION_REPORT.md` |
| Release and Measurement Agent | Did it reach users safely and create impact? | `docs/release/RELEASE_PLAN.md`, `docs/product/POST_LAUNCH_REVIEW.md` |
| Recorder | Can the next person continue? | `.harness/STATE.md`, `.harness/HANDOFF.md`, follow-up list |

## Recommended squad flow

```text
Product Strategist
→ Spec Architect
→ System Architect
→ Implementation Agent
→ Evaluation Agent
→ Release and Measurement Agent
→ Recorder
```

For smaller tasks, collapse roles:

```text
solo = all roles in one agent
review-pair = Implementation Agent + Evaluation Agent
squad = all roles separated
```

## Role rules

The Implementation Agent must not redefine the spec while implementing. The Evaluation Agent must not trust implementation summaries without checking the contract and changed files. The Recorder must preserve enough state for another agent or human to continue without reconstructing the session from scratch.

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-28 | 13:14 GMT-3 | Converted squad guidance into a portable reference module and condensed role definitions into an operational table. |
