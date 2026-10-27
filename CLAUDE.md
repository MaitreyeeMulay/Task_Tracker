# Project rules for Claude Code

## How we work

- Plan first. Do not change any files until I approve the plan.
- Ask me when the spec is unclear. Do not guess.
- Commit only when I say so. Never push.
- Never start or stop my dev server or containers. Ask me.
- Every scripted request uses a 15-second timeout.
- Never run a command that does not finish on its own.
- Write the test first and show me it failing before the fix.
- Never print secrets. No secrets in code, logs, output or committed env files.
- Report results, including failures and your own mistakes, before moving on.

## Definition of done (every milestone)

- Typecheck, tests and lint pass.
- No new high or critical security findings.
- The README section for the milestone is updated.
- Decisions and trade-offs are noted in `docs/decisions.md`.
- The threat model in `docs/threat-model.md` is updated if the attack surface changed.

## Conventions

- TypeScript in strict mode. Small modules. Put logic in pure functions and test them.
- Database changes are additive migrations. The previous version of the code must still work against the new schema.
- Every table that holds team data has row-level security, closed by default.
- External calls (email, webhooks) go behind an interface with a stub for development.
- A step that cannot be safely repeated is never retried automatically. Flag it for a person.

## Security and DevSecOps

- Never disable, skip or weaken a scanner, a gate or a branch rule to make a build pass. Ask me.
- Every GitHub workflow sets the minimum token permissions it needs.
- Pin third-party GitHub Actions to a commit SHA. Never use `latest` image tags.
- A security finding is fixed, suppressed with a written reason in `docs/security-decisions.md`, or accepted with an expiry date. Fixes get a test where possible.
- Review every new dependency before adding it, and explain why it is needed.
- Verify webhook signatures. Rotate secrets without downtime.
- No passwords or keys between services in the cloud. Use identities.
- Log ids and counts, never personal data or request bodies.

## Reference

- The spec is in `SPEC.md`. If code and spec disagree, stop and ask me.