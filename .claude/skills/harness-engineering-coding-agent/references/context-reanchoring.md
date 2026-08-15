# Context re-anchoring protocol

This reference defines how the agent recovers when it drifts from the agreed contract during a long implementation task. It is a corrective step inside Phase 6 (implementation loop), not a new gate.

## Purpose

As a session grows, earlier context loses weight: the model attends more to recent tokens, and the original requirements, data model and user flow can fade from the active window. The symptom is drift, the agent quietly rebuilds on a degraded understanding instead of the agreed contract. Re-anchoring restores the governing context before more code is written on a wrong foundation.

## When to trigger

Re-anchor the moment any of these appear during a task:

- the agent reintroduces behavior that was marked out of scope;
- the output contradicts the data model or schema already agreed;
- the agent forgets or rewrites the user flow that was defined;
- decisions recorded earlier in the run are reversed without being flagged;
- the agent asks for, or invents, information that already exists in the contract or spec;
- a long single task has consumed a large amount of context and quality is visibly degrading.

## Recovery steps

1. Stop. Do not add more changes on top of the drift.
2. Reload the governing artifacts into the active context, normally `.harness/CONTRACT.md`, the data model and `.harness/ACCEPTANCE_CRITERIA.md`. For product or flow drift, also reload the relevant PRD and user-flow description.
3. Restate the current task in one or two lines, tied to its requirement IDs.
4. Diff the drifted output against the reloaded contract and name what diverged.
5. Resume the implementation loop from the restated task, correcting the divergence first.

## Notes

Re-anchoring is cheap; rebuilding on a drifted base is expensive. Prefer small tasks and frequent verification so drift is caught early, when one re-anchor fixes it.

Keep the governing artifacts compact for exactly this reason. A short, current contract is easy to re-paste; a bloated one is not. This is the same discipline as the "no giant context dump" rule, applied mid-run.

## Origin

This protocol generalizes a context-recovery practice demonstrated by Vinícius Lana (founder of AI Coders Academy) for building software with AI: when the agent starts to hallucinate or break the application, re-paste the governing artifacts (the spec or PRD, the data-model schema and the user-flow) to restore the model's context before continuing.

It is related to, but not the same as, his PREVC workflow. PREVC is a five-phase process (Planning, Review, Execution, Validation, Confirmation) whose stated goal is to stop LLMs from generating code blindly by enforcing specifications before code, context awareness, human checkpoints and reproducible quality. Re-anchoring is a mid-execution technique that keeps that context intact during the Execution phase; it is not itself one of the five phases. See [AI Coders Academy](https://www.aicoders.academy/) and the [`dotcontext`](https://github.com/vinilana/dotcontext) project (formerly `@ai-coders/context`).
