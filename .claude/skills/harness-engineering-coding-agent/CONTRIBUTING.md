# Contributing

Obrigado por contribuir com **Harness Engineering Coding Agent**. Este repositório contém uma Agent Skill; mudanças aqui alteram como agentes se comportam, tomam decisões, consultam contexto e pedem consentimento ao usuário.

## Principles

Contributions should preserve three properties: **clareza operacional**, **segurança por consentimento** and **mínima complexidade suficiente**. Do not add process for its own sake. Add rules only when they reduce ambiguity, prevent unsafe behavior or improve repeatability.

## What to change where

| Need | Preferred file |
|---|---|
| Agent behavior, activation rules or output format | `SKILL.md` |
| Human-facing explanation, installation or examples | `README.md` |
| Reusable protocols or deeper guidance | `references/` |
| Reusable deliverable formats | `templates/` or `examples/` |
| Validation or automation | `scripts/` |
| Release notes | `CHANGELOG.md` |
| Maintenance rules | `GOVERNANCE.md` |

## Version-check requirement

Any behavioral change must preserve the origin version check rule: the skill may consult its upstream repository, read README/CHANGELOG, summarize changes and ask whether the user wants to update, but it must never update itself silently or overwrite local edits without explicit approval.

Treat this repository as an operational harness. A contribution should not remove gates, weaken sensors, reduce traceability, hide update risk, expand autonomy or degrade handoff quality unless the trade-off is explicit, justified and validated.

## Before opening a pull request

Run the local validation command when present:

```bash
python3 scripts/validate_skill.py
```

Then review the diff manually and answer these questions in the PR description:

| Question | Expected answer |
|---|---|
| Did this change alter agent behavior? | Explain the behavior. |
| Is this a breaking change for existing users? | Yes/No, with reason. |
| Does the update preserve explicit user consent before self-update? | Yes. |
| Does the update preserve or improve traceability, sensors, safety boundaries and handoff quality? | Yes, or explain the trade-off and risk. |
| Were local validation checks run? | Include command and result. |

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-06-04 | 12:17 GMT-3 | Added regression-free harness improvement expectations for behavioral contributions and PR review. |
| 2026-06-02 | 09:02 GMT-3 | Added contribution guidelines for maintaining the skill as an update-aware public repository. |
