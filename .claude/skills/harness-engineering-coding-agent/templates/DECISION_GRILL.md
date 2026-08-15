# Decision Grill

Use this artifact when a plan, architecture, PRD, semantic specification or release path needs adversarial clarification before implementation.

The purpose is not to slow the work down. The purpose is to expose ambiguity, hidden dependencies, missing decisions and unsafe assumptions while the cost of changing direction is still low.

## Task context

| Field | Value |
|---|---|
| Task / initiative |  |
| Date |  |
| Agent / reviewer |  |
| Related artifacts |  |
| Decision owner |  |

## Grill protocol

The agent must first answer any question that can be resolved by inspecting the codebase, existing docs, logs, schemas, tests, configuration or repository history. The agent should ask the user only when the missing answer blocks safe progress or requires a business/product judgment.

Questions should be handled one dependency at a time. For each question, the agent must provide a recommended default answer, label confidence and record whether the answer is confirmed, inferred or still open.

| ID | Critical question | Why it matters | Recommended answer | Source | Status |
|---|---|---|---|---|---|
| Q-001 |  |  |  | confirmed / inferred / user-needed | open / resolved |

## Decision tree

| Branch | Dependency | Options considered | Chosen path | Rationale | Reversible? |
|---|---|---|---|---|---|
| D-001 |  |  |  |  | yes / no |

## Assumptions under pressure

| Assumption | Risk if wrong | How to verify | Owner | Deadline |
|---|---|---|---|---|
|  |  |  |  |  |

## User questions that remain necessary

Ask only the questions below. Each one must block a safe next step or require a product/business decision.

| Question | Recommended answer | Blocking reason |
|---|---|---|
|  |  |  |

## Outcome

| Field | Value |
|---|---|
| Shared understanding reached? | yes / no |
| Ready for implementation? | yes / no |
| Required artifact updates |  |
| Follow-up decisions |  |

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-29 | 06:05 GMT-3 | Initial template for adversarial decision clarification inspired by the `grill-me` interviewing pattern. |
