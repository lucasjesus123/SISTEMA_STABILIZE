# Product Engineering Discovery

Use this reference before PRD or implementation when the product intent is unclear.

The goal is to prevent the agent from building a technically correct feature that solves the wrong problem.

## When to load this reference

Load this file when the task is a `product-feature`, when the user request contains product ambiguity, when success metrics are unclear, or when the smallest valuable version is not obvious.

## Output files

| File | Purpose |
|---|---|
| `docs/product/PRODUCT_INTENT.md` | Clarifies problem, user, scope, assumptions and decision. |
| `docs/product/METRICS_PLAN.md` | Defines success signals before implementation. |
| `.harness/OPEN_QUESTIONS.md` | Keeps unknowns visible instead of hiding them inside prose. |

## Questions to answer

### Why build this?

- What user problem are we solving?
- Who has this problem?
- Why is this problem worth solving now?
- What job is the user trying to get done?
- What happens if we do not build it?
- What existing alternatives compete with this?

### What exactly should exist?

- What is the smallest valuable version?
- What is explicitly out of scope?
- What assumptions are we making?
- What domain expertise is required?
- What business model, pricing or operational constraint matters?

### How will we know it worked?

- What is the primary success metric?
- What leading indicators matter?
- What lagging indicators matter?
- What signals of adoption should be tracked?
- What experiment or validation loop is needed?

## Critical interview protocol

When intent is unclear, the agent should stress-test the plan before drafting PRD or writing code. It must walk the decision tree one dependency at a time and provide a recommended answer for each critical question.

The agent should not ask the user questions that can be answered by reading the codebase, existing documentation, analytics notes, tests, schemas, configuration or repository history. It should ask the user only when the answer requires business judgment, strategic trade-off, prioritization or approval.

Use `.harness/DECISION_GRILL.md` when the plan contains multiple unresolved branches or when wrong assumptions would create meaningful rework.

## Rules

Do not invent missing business facts as truth. Label assumptions explicitly. Separate user need from proposed solution. Keep the MVP small. Define measurement before implementation. Ask one blocking question at a time, and pair it with the agent's recommended answer.

## Output standard

The final product intent must separate confirmed facts, assumptions, decisions, open questions and out-of-scope items. If the agent cannot answer a business question, it must record the gap and ask the user only when the missing answer blocks safe progress.

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-28 | 13:08 GMT-3 | Converted from subskill to portable reference module and clarified when to load it. |
| 2026-05-29 | 06:05 GMT-3 | Added critical interview protocol and decision grill artifact for product ambiguity. |
