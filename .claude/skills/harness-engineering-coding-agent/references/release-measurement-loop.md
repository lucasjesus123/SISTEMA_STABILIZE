# Release Measurement Loop

Use this reference when a change will reach users, production, customer data, integrations or operational workflows.

The goal is to make release and learning part of the harness, not an afterthought.

## When to load this reference

Load this file for production deployment, staged rollout, feature flags, database migrations, user-facing behavior, customer data, third-party integrations, operational workflow changes, incident follow-up or any change where rollback and observability matter.

## Outputs

| File | Purpose |
|---|---|
| `docs/release/RELEASE_PLAN.md` | Defines rollout, ownership, rollback, observability and communication. |
| `docs/product/POST_LAUNCH_REVIEW.md` | Captures adoption, impact, incidents and learning after launch. |
| `.harness/EVALUATION_REPORT.md` | Records verification evidence before release. |

## Release questions

- How will this reach users?
- Is the rollout staged?
- Is there a feature flag?
- Is there a rollback strategy?
- Who owns the release?
- What is the blast radius?
- What logs, metrics, traces, audit events and replay evidence are required?
- What alerts are required?
- What is the post-launch review date?

## Measurement questions

- What behavior should change?
- What adoption signal proves value?
- What leading indicator should move first?
- What lagging indicator matters later?
- What should we learn even if the feature fails?

## Rollback standard

A release plan is weak if rollback is described only as “revert if needed”. A useful rollback plan states who can trigger rollback, what condition triggers rollback, what command or process executes rollback, what data migration risk exists and how users or customers will be informed if needed.

## Observability standard

Do not launch unobservable behavior. For user-facing, operational, agentic or AI-native changes, define logs, metrics, dashboards, traces, audit events or replay evidence before treating deployment as success.

## Replay, auditability and semantic observability

For agentic workflows, automations, AI-native behavior or distributed operations, release readiness must include more than uptime. The system should expose enough evidence to understand what happened, why it happened and whether the behavior can be reconstructed after the fact.

| Concern | Release question |
|---|---|
| Replay | Can the behavior be reconstructed from events, logs, traces or audit records? |
| Auditability | Can a human explain who or what triggered the behavior and which decision path was followed? |
| Semantic observability | Do signals map to user/system behaviors rather than only low-level infrastructure metrics? |
| Sensitive data | Are logs, traces and events free from secrets, tokens and unnecessary personal data? |
| Recovery | Is there a defined path for retry, rollback, compensation or human intervention? |

Do not add event sourcing, graph storage, vector storage or specialized infrastructure by default. Add them only when the semantic requirements justify the complexity.

## Rules

Do not launch critical changes without rollback. Do not launch unobservable behavior. Do not treat deployment as success. Success means safe release plus measured learning.

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-28 | 13:12 GMT-3 | Converted from subskill to portable reference and expanded rollback and observability standards. |
| 2026-05-29 | 05:56 GMT-3 | Added replay, auditability and semantic observability guidance for AI-native and agentic releases. |
