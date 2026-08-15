# Minimal Use Example

This example shows how a coding agent should apply the skill without creating unnecessary process.

## User request

```text
Add password reset to the existing SaaS app. Use the existing auth provider. Do not deploy.
```

## Classification

| Field | Value |
|---|---|
| Task type | `feature`, `security-data` |
| Execution mode | `review-pair` recommended, `solo` acceptable if low risk and local only |
| Risk | Medium, because auth and user identity are involved |

## Expected agent behavior

The agent should not jump directly into implementation. It should first inspect `AGENTS.md`, auth documentation, current auth flow, route structure and tests. It should create or update `.harness/CONTRACT.md`, `.harness/ACCEPTANCE_CRITERIA.md` and `.harness/TEST_PLAN.md` because the feature touches authentication.

## Example contract fragment

| ID | Requirement | Verification method |
|---|---|---|
| `AUTH-001` | A user can request a password reset using the existing auth provider. | Integration or provider-mocked test plus manual flow. |
| `AUTH-002` | The UI must not reveal whether an email exists. | Negative-case test or manual verification. |
| `SEC-001` | Reset tokens must not be logged or exposed in client-visible state. | Code review and log inspection. |
| `UI-001` | The login page links to password reset. | UI test or manual verification. |

## Implementation loop

The agent should implement one slice at a time: route or page entry point, provider call, user feedback state, tests, documentation update and handoff. It should run relevant tests, lint, typecheck and build if available.

## Final response shape

```text
Summary
- Added password reset flow using the existing auth provider.

Verification
- pnpm test auth-reset: passed
- pnpm lint: passed
- pnpm typecheck: passed
- Manual flow with provider sandbox: passed
- Blind spot: production email template was not changed because deployment was out of scope.

Risks
- Provider rate limits were not verified.
- Scope check: no changed line fell outside the original password-reset request and required auth verification artifacts.

Files changed
- src/auth/reset-password.tsx
- src/routes/login.tsx
- tests/auth/reset-password.test.ts
- .harness/CONTRACT.md
- .harness/TEST_PLAN.md
- .harness/EVALUATION_REPORT.md
- .harness/HANDOFF.md

Next action
- Review email template copy before deployment.
```

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-05-28 | 13:22 GMT-3 | Updated example to show portable agent behavior and security-aware acceptance criteria. |
| 2026-06-01 | 18:45 GMT-3 | Updated final response example with explicit surgical-change scope check. |
