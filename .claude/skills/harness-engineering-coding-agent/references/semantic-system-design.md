# Semantic System Design

Use this reference when a task involves architecture, agentic systems, AI-native workflows, distributed behavior, automation, orchestration, stateful systems, event-driven flows or significant ambiguity about how behavior should be represented.

The goal is not to force a specific DSL, runtime or database stack. The goal is to make the agent describe the **semantic model** before choosing implementation details.

> A semantic specification describes what the system means and guarantees before it describes which files, functions, tables or services will implement it.

## When to use this reference

| Trigger | Why it matters |
|---|---|
| The system has agents, workflows, automations or probabilistic behavior. | The implementation needs traceability, replayability and clear control boundaries. |
| The change spans frontend, backend, data, queues, external APIs or background jobs. | Behavior can drift across layers unless it is declared once. |
| The request includes behavior, orchestration, runtime, state machine, event, memory, retrieval, graph, vector, replay, audit or observability. | These are semantic architecture concerns, not just coding concerns. |
| The agent is tempted to generate several disconnected implementations of the same behavior. | A behavior contract prevents duplicated logic and architectural drift. |
| The task is architectural and there are multiple plausible patterns. | A state-of-the-art review should happen before committing to a design. |

## Semantic specification fields

| Field | Question |
|---|---|
| Behavior | What actor, entity or system behavior is being declared? |
| Trigger | What starts the behavior? |
| Preconditions | What must be true before it can run? |
| Steps | What observable steps happen in order? |
| Invariants | What must always remain true? |
| Guarantees | What does the system promise after successful execution? |
| Constraints | What must the system never do? |
| Events | What events are emitted, stored or observed? |
| State | What state changes and where is it persisted? |
| Replay | Can this behavior be reconstructed or replayed? |
| Observability | Which logs, metrics, traces or audit records prove what happened? |
| Failure modes | What happens on timeout, retry, duplicate input, partial failure or external outage? |
| Security | Which authorization, privacy, secrets and abuse constraints apply? |

## Behavior contract syntax

Use plain language by default. If useful, add a lightweight behavior block. This is intentionally tool-neutral and does not require any specific DSL.

```text
behavior User.RequestPasswordReset {
  actor User
  trigger LoginPage.forgotPasswordSubmitted(email)

  preconditions
    - email has valid format

  steps
    - normalize email
    - call auth provider password reset endpoint
    - show generic success message

  guarantees
    - no account enumeration is exposed
    - reset token is never logged
    - audit event PasswordReset.Requested is recorded when available

  failure_modes
    - provider unavailable -> show retry-safe message
    - rate limited -> preserve generic response and record operational signal

  observability
    - metric auth.password_reset.requested
    - metric auth.password_reset.provider_error
    - audit event without sensitive token data
}
```

## State-of-the-art review gate

For architecture tasks, the agent should perform a proportionate review before implementation. The review should not become academic research. It should compare credible options and choose the simplest design that preserves the required guarantees.

| Review question | Expected answer |
|---|---|
| What established patterns apply? | For example: state machine, event sourcing, transactional outbox, workflow engine, actor model, CQRS, policy engine, retrieval-augmented memory, graph traversal or conventional CRUD. |
| What is the minimum architecture that satisfies the guarantees? | The agent must avoid adding infrastructure only because it is fashionable. |
| Which advanced pattern is tempting but unnecessary? | Record the rejected option and why it was not used. |
| What would change if scale, auditability or replay became mandatory? | Capture the future migration path without implementing it prematurely. |

## Architecture option prompts

| Concern | Ask |
|---|---|
| Memory | Does the system need durable memory, contextual retrieval or only transactional state? |
| Relationships | Are graph relationships central to the behavior or can joins/domain models handle it? |
| Semantics | Is semantic search needed or is exact lookup enough? |
| Causality | Must we reconstruct why something happened? |
| Replay | Must we replay events for debugging, compliance, convergence or agent learning? |
| Observability | What must be visible during normal operation and during incidents? |
| Consistency | Is strong consistency required, or is eventual consistency acceptable? |
| Automation | Can a human intervene, or must the workflow self-heal? |
| Harness control | Which parts of the workflow are deterministic, which are inferential and which require human approval? |
| Harness regression | If this workflow or automation changes, how will we know it did not reduce safety, traceability or verification quality? |

## Decision rule

Prefer the smallest design that preserves the behavior, guarantees, constraints, observability and recovery path. Add specialized infrastructure only when a requirement needs it. When in doubt, document the semantic contract first and defer stack complexity until the requirement proves it is necessary.

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-06-04 | 12:17 GMT-3 | Added harness control and harness regression prompts for agentic workflows and automation changes. |
| 2026-05-29 | 05:45 GMT-3 | Added semantic system design reference inspired by state-of-the-art-driven development, adapted as a portable and proportional workflow for coding agents. |
