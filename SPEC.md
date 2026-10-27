# Incident and runbook tracker (DevSecOps): spec

## Goal

A small service that turns monitoring alerts into incidents, guides responders with runbooks, tracks response-time targets (SLAs) and keeps an audit trail.

It exists to show cloud operations and DevSecOps practice end to end: reliable background work, least-privilege security, infrastructure as code, a live deployment, monitoring that pages someone, and a delivery pipeline where every change is scanned, gated, signed and traceable.

## Non-goals

- No mobile app, SMS or phone paging. Notifications go through a provider interface, with email as the only real channel.
- No AI features in v1.
- No multi-region deployment.
- No billing and no self-signup.

## Users and roles

- **Admin:** manages teams, services, integrations and users.
- **Responder:** acknowledges, updates and resolves incidents for their teams, and works through runbooks.
- **Viewer:** read-only, for managers and auditors.

Each user belongs to one or more teams, and all incident data is scoped to teams.

## Stack (confirmed 2026-10-26)

Next.js and TypeScript, Postgres, Docker, Vitest, GitHub Actions, OpenTelemetry. Infrastructure as code in Terraform (AWS).

## Core concepts

- **Service:** something that is monitored, owned by a team.
- **Integration:** a webhook endpoint with its own signing secret, linked to a service.
- **Alert:** a raw event from a monitoring tool, stored as received.
- **Incident:** groups the alerts for one service. Status: triggered, acknowledged, mitigated, resolved. Severity: SEV1 to SEV4.
- **Timeline:** append-only events on an incident (status changes, notes, notifications, runbook steps).
- **Runbook:** a markdown document with a checklist, linked to a service or an alert rule.
- **SLA targets:** time to acknowledge and time to resolve, set per severity.
- **Notification:** a message to a responder, sent through a provider interface with a stub provider for development.

## Behaviour that must hold

1. **Ingestion is idempotent.** The same alert fingerprint never creates a second incident while one is open. It adds an entry to the timeline instead.
2. **Webhooks are verified** with an HMAC signature, and a secret can be rotated with two valid at once.
3. **Timers are durable.** SLA timers are stored as wake-at times in the database and survive restarts.
4. **No lost or doubled notifications.** A notification is never lost. If a worker dies mid-send, the outcome is flagged for a person to check instead of being resent automatically. Escalation after a missed acknowledgement is automatic.
5. **Team isolation is enforced by the database.** Row-level security limits each user to their teams, and Viewers cannot write.
6. **Everything is audited.** Every change and every export is written to an append-only audit log.

## Data model (sketch)

teams, users, memberships, services, integrations, alerts, incidents, incident_events, runbooks, runbook_runs, notifications, timers, audit_log.

## DevSecOps requirements

Security is part of every stage, not a final check. The tools are proposals, so confirm each one during planning, including its terms for private repositories. The thresholds are starting values.

| Stage | Control | Proposed tool | Gate |
| --- | --- | --- | --- |
| Plan | Threat model (STRIDE) in `docs/threat-model.md`, with security acceptance criteria for each milestone | Manual, reviewed before M1 | No milestone starts without it |
| Code | Secret scanning | gitleaks | Fail on any finding |
| Pull request | Static analysis of the code | CodeQL | Fail on high or critical |
| Pull request | Vulnerable dependencies, and automatic updates for packages and GitHub Actions | Dependabot, plus npm audit or OSV-Scanner | Fail on critical |
| Pull request | Infrastructure as code scan | Checkov and tflint for Terraform | Fail on high |
| Build | Container image scan | Trivy | Fail on critical that has a fix |
| Build | Software bill of materials for every image | Syft or CycloneDX | Published as a build artifact |
| Build | Sign images and record provenance | cosign or GitHub artifact attestations | Deploy only signed images built from main |
| Deploy | Policy as code, for example no public data stores, private endpoints required, tags present | OPA with Conftest | Non-compliant deployment is rejected |
| Staging | Dynamic scan of the running app | OWASP ZAP baseline scan | Fail on high, report stored |
| Runtime | Security alerts, cloud security recommendations reviewed, audit log | Cloud-native tools | Reviewed each milestone |

Process controls that apply from the first commit:

- Branch protection on main, with required reviews and passing checks.
- Every workflow sets the minimum `GITHUB_TOKEN` permissions it needs.
- Third-party actions are pinned to a commit SHA.
- The pipeline signs in to the cloud with OIDC, with no long-lived secrets.
- A `SECURITY.md` explains how to report a vulnerability.
- Proposed fix times: critical within 7 days and high within 30 days. A finding is fixed, suppressed with a written reason in `docs/security-decisions.md`, or accepted with an expiry date.

## Milestones

Each milestone ends with something runnable and tested.

**Scope decision (2026-10-26):** with 2 days available, M0 to M3 are built. M4 to M6 are designed and documented but not built, and the security report marks their controls as "not done". M7 is polish if time allows.

| # | Deliverable | Done when |
| --- | --- | --- |
| M0 | Repo, rules file, CI, local Docker stack, health check, first migration, branch protection, secret scanning, Dependabot, pinned actions, minimal token permissions, threat model started | CI is green: typecheck, tests, image build, IaC compile and lint, secret scan |
| M1 | Webhook ingestion, signature check, dedupe, CloudWatch alarm adapter via SNS (with SNS signature verification), threat model reviewed | A sample alert creates an incident, a duplicate does not, a forged signature is rejected, and CodeQL runs clean on the code |
| M2 | Incident list and detail, status changes, timeline, team scoping | A Responder sees only their teams' incidents, and a Viewer cannot write |
| M3 | Runbooks, linking to services, checklist runs with timestamps | A runbook opens from an incident and its steps are recorded on the timeline |
| M4 | Worker, durable SLA timers, escalation, notification outbox with failure handling | Killing the worker mid-timer and mid-send, then restarting, loses nothing and sends nothing twice |
| M5 | Login with lockout, OIDC for production, audit log and export, security headers, CSRF protection, image scan, SBOM | Cross-team access, replayed alerts and forged requests all fail in tests, and every image has an SBOM |
| M6 | Live deployment, signed images only, policy as code, dynamic scan, alerts as code, restore drill, budget alert, dashboards | A public URL works, an unsigned image is rejected, ZAP reports no high findings, a test alert pages by email, and the restore time is measured and written down |
| M7 | Code review pass, security report, README with decisions and verified-versus-untested notes | The README lets a stranger run it, and every claim in it is tested or marked untested |

The M7 security report is a table of controls with one status each: enforced in CI, enforced by policy, manual, or not done. It also lists findings that were fixed, suppressed or accepted, with reasons.

## Quality bar (every milestone)

- Typecheck, tests and lint pass.
- No new high or critical security findings.
- Any new dependency is reviewed and justified.
- The threat model is updated if the attack surface changed.
- Every bug fix has a test that was shown failing first.
- Docs are updated.
- Results and failures are reported honestly before moving on.

## Testing

- **Unit (Vitest):** parsing, fingerprinting, SLA maths, state transitions.
- **Database tests on real Postgres:** row-level security, the queue and the timers.
- **Failure tests:** kill the worker mid-timer and mid-notification, restart, and assert no loss and no duplicate.
- **Security tests:** forged signature, replayed alert, cross-team access, CSRF, oversized payloads, rate limiting.
- **Pipeline tests:** prove each gate works by committing a planted fake secret, a vulnerable dependency and a deliberately risky configuration on a throwaway branch, and watching each one fail the build.
- **Manual UI pass** by me at every milestone.

## Observability and operations

- Structured logs, OpenTelemetry traces and a health endpoint.
- Alerts as code for: site down, error rate, worker silent, overdue timers, database storage, and security events such as role changes.
- A timed restore drill, and a budget alert before anything is deployed.

## Deployment

Two environments (staging and production) if the budget allows, otherwise one with a clear note. Images are built, scanned, signed and given an SBOM in CI. Deploys come from main after an approval, migrations run first, and every migration is additive.

## Decisions (made 2026-10-26)

1. Cloud: AWS, free-tier services only. Free-tier terms are checked again before any deployment.
2. Infrastructure as code: Terraform.
3. Auth: a dev login for local development and tests, and OIDC in production. The dev login is disabled in production by config.
4. Repository: public. No secrets are ever committed.
5. Time: 2 days. See the scope decision under Milestones.
6. Alert source: CloudWatch alarms delivered through SNS, plus a generic HMAC-signed webhook.

## Risks

- **Scope.** Build M0 to M3. M4 to M6 are designed only, and M7 is polish.
- **Cost.** Set a budget alert before deploying anything.
- **Account friction.** If the deployment is blocked, finish M0 to M5 locally and document the deploy plan clearly.
- **Scanner noise.** Triage every finding in writing: fix it, suppress it with a reason, or accept it with an expiry date. Never switch a scanner off to make the build pass.