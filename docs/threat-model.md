# Threat model (STRIDE)

Status: **started in M0. It must be reviewed before M1 begins** (SPEC.md requires this).

## System overview

```
CloudWatch alarm -> SNS -> POST /api/ingest/sns ------\
Monitoring tool  -> POST /api/ingest/webhook (HMAC) ---> Next.js app -> Postgres (RLS)
Browser (Admin / Responder / Viewer) -> Next.js app --/
GitHub Actions -> build, scan, (later: sign, deploy to AWS via OIDC)
```

## Assets

- Incident data, which belongs to teams. Confidentiality is enforced between teams.
- Integration signing secrets.
- User sessions and roles.
- The audit log, which must stay complete and unaltered.
- The CI pipeline and its artifacts. This is the supply chain.

## Trust boundaries

1. Internet → ingestion endpoints (unauthenticated callers, verified by signature).
2. Browser → app (authenticated users).
3. App → database (the app role is not the owner and does not bypass RLS).
4. Repository → CI → cloud (pull requests from forks, third-party actions).

## STRIDE by component

### Webhook and SNS ingestion (M1)

| Threat | Example | Mitigation | Acceptance test |
| --- | --- | --- | --- |
| Spoofing | Forged alert | HMAC with constant-time compare. SNS signature verified, cert URL host pinned to `sns.<region>.amazonaws.com`, SignatureVersion 2 only | Forged signature → 401 |
| Tampering | Payload altered in transit | The signature covers the raw body | Modified body → 401 |
| Repudiation | Unclear who sent an alert | The raw alert is stored with its integration id | Alert row links to the integration |
| Information disclosure | Error leaks internals | Generic errors. Logs hold ids and counts only | Log assertions in tests |
| Denial of service | Huge payload, alert flood | Body size limit, rate limiting (M5), dedupe in the DB | Oversized body → 413 |
| Elevation of privilege | Alert writes into another team's service | The integration is bound to one service, and the service to one team | Cross-team insert fails |
| Replay | Old valid alert re-sent | Timestamp window plus a fingerprint dedupe | Replay outside the window → 401 |
| SSRF | Malicious SNS `SubscribeURL` or `SigningCertURL` | Strict host allow-list (`sns.<region>.amazonaws.com`), https only, no port or user info, no redirects, 15-second timeout. Confirmation goes behind an interface (stubbed in dev) | Unit tests: metadata IP, look-alike hosts, user-info trick, http, ports rejected with no request made (passing) |
| Spoofing via a foreign SNS topic | Attacker's own topic, validly signed by AWS | Topic ARN must equal the integration's configured topic, checked before any fetch | Unit test (passing) |
| Weak signature algorithm | SignatureVersion 1 (SHA-1) | Only version 2 (SHA-256) accepted | Unit test (passing) |

### Team data and the database (M0, M2)

| Threat | Mitigation | Acceptance test |
| --- | --- | --- |
| Cross-team read or write | RLS enabled and forced on every team table, closed by default. User context set with `SET LOCAL` per transaction | Without context, 0 rows. Cross-team query returns 0 rows |
| Viewer writes | RLS write policies exclude Viewers | Viewer UPDATE fails |
| Audit tampering | INSERT only for app roles (admins may also read their teams' rows); triggers block UPDATE/DELETE/TRUNCATE for everyone | DB tests |
| Spreadsheet formula injection via audit export | Cells starting with = + - @ tab CR prefixed with ' | Unit test |
| Ingestion path over-privileged | `app_ingest` has its own minimal grants and policies: no access to users, memberships or audit reads, cannot resolve or delete | DB tests (passing) |
| Duplicate incidents from races or retries | Partial unique index per open fingerprint. Unique `(integration_id, external_id)` | DB tests (passing) |
| Signing secrets in the database | Only a Secrets Manager reference is stored | DB test on columns (passing) |
| Timeline tampering | `incident_events` is append-only by trigger | DB test (passing) |
| SQL injection | Parameterised queries only, plus CodeQL | CodeQL is clean |
| App connects with too much privilege | `app_rw` is NOLOGIN, not a superuser, no BYPASSRLS, owns no tables. **Gap:** locally the app still uses the compose superuser until T14 | DB test on the role's attributes (passing) |
| Migration tampering | Checksums on applied migrations, ordering checks, advisory lock | Unit tests (passing) |
| Tests wipe a real database | Test runner refuses any database whose name doesn't end in `_test` | Unit test (passing) |

### Web app and auth (M2, M5)

| Threat | Mitigation | Status |
| --- | --- | --- |
| Dev login used in production | Disabled by config, with a test | Done (M2) |
| Session forgery or theft | HMAC-signed cookie, constant-time check, HttpOnly, SameSite=Lax, Secure in prod, 8-hour expiry, secret rotation | Done (M2), unit tests |
| Cross-team access via guessed ids | RLS on `app_rw`: another team's incident reads as "not found" | Done (M2), DB tests |
| Viewer writes through the UI or by crafted request | RLS write policies exclude viewers. The UI hides buttons, but the DB is the gate | Done (M2), DB tests |
| Brute force on password login | Lockout after 5 failures (15 min), rate limits per address and per email, generic errors, timing equalised | Done (M5), DB and unit tests |
| Account enumeration | One message for every failure; scrypt runs for unknown emails too | Done (M5), DB test |
| Pre-login database access | `app_auth` role: login columns only | Done (M5), DB test |
| CSRF | SameSite=Lax cookies, Next server-action Origin check, proxy refuses cross-site/foreign-Origin state changes | Done (M5), unit tests |
| XSS / clickjacking | Nonce CSP with `strict-dynamic`, no `unsafe-eval` in production, `frame-ancestors 'none'`, nosniff | Done (M5), unit tests; live check pending |
| Alert flood | 300/min per integration (429), body cap, dedupe | Done (M5) |
| OIDC login CSRF / code injection | State + PKCE (S256) + nonce in a signed, short-lived cookie | Done (M5), end-to-end test with fake provider |
| Forged or replayed ID token | Signature (JWKS), issuer, audience, expiry and nonce checked by openid-client | Done (M5), fake-provider test |
| Account takeover through the identity provider | Link only by a verified email, once; after that by subject. No self-signup | Done (M5), DB tests |
| XSS in runbook markdown | No HTML is ever produced: Markdown becomes plain-text blocks rendered by React | Done (M3), unit test with `<script>` and `<img onerror>` |
| Checklist poisoned with a bad step | New steps from incidents are only *proposed*, then a team responder/admin accepts them. Every add, accept, reject, retire and edit is audited. Retire instead of delete keeps history | Done (2026-11-06), DB tests |
| Runbook steps faked or repeated | RLS: only team admins/responders, as themselves. Primary key stops double completion. Append-only | Done (M3), DB tests |

### CI and supply chain (M0)

| Threat | Mitigation | Gate |
| --- | --- | --- |
| Secret committed | gitleaks in CI, GitHub push protection | Fails on any finding |
| Malicious or compromised action | Actions pinned to a SHA, Dependabot for actions | Review |
| Over-privileged token | `permissions: contents: read` by default | Review |
| Vulnerable dependency | OSV-Scanner, Dependabot | Fails on critical |
| Risky IaC | Checkov, tflint | Fails on high |
| Vulnerable OS or library packages in the image | Trivy image scan on every build; SBOM per image for later lookups | Fails on a critical with a fix |
| Unsigned or tampered image deployed | Image signing and "deploy only signed" | **Not done** (M6) |
| Fork pull request steals secrets | No secrets in PR workflows. `pull_request_target` is banned by a unit test. `persist-credentials: false` on every checkout | Unit test (passing) |
| Workflow injection | CodeQL `actions` analysis on every PR. No untrusted `${{ }}` inside `run:` | CodeQL (passing on `main`) |
| Unpinned action or image | Unit test fails on any action not pinned to a SHA or any Docker image without a digest | Unit test (passing) |
| Tampered scanner binary | gitleaks verified against a SHA-256 in the workflow. Checkov image pinned by digest | CI (passing) |
| Terraform state leaks values | State is never committed (`*.tfstate` is git-ignored). Sensitive variables live only in a git-ignored `terraform.tfvars`. M6: encrypted remote state | Review |
| Provider binary swapped | Exact provider version plus committed lock file hashes | `terraform init` verifies the hashes |
| Surprise cloud bill | Budget alert at 50%, 80%, 100% and forecast 100% | `terraform test` (passing). The real apply is untested |

### Worker and notifications (M4)

| Threat | Mitigation | Test |
| --- | --- | --- |
| Lost notification (crash) | Timer fire and outbox write share one transaction; durable timers | Crash test: SIGKILL mid-timer (passing) |
| Duplicate notification (crash or retry) | Unique outbox key; claim committed before send; stale "sending" goes to human review, never auto-resent | Crash test: SIGKILL mid-send (passing) |
| Worker over-privileged | `app_worker` role: reads what it needs to address messages, writes only timers/outbox/escalation events | DB tests |
| Email addresses leaked in logs | Logs carry notification and incident ids only | Code review; stub logs ids only |
| Alert spam to the wrong people | Recipients from the incident's own team only; viewers never paged | DB test |
| Duplicate email from SDK retries (M6) | SES client built with `maxAttempts: 1`; ambiguous failures go to human review | Unit tests (classification); live check in M6-D |
| SES error text leaks an address into logs (M6) | Only the error name is kept as the code | Unit test |

### Database credentials on AWS (M6)

| Threat | Mitigation | Test |
| --- | --- | --- |
| Stolen database password | App and worker use IAM auth tokens (15 minutes, signed with the task role). No password in config, image or logs | Unit tests (`db-connection`) |
| Token or password sent to an impostor server | TLS with `rejectUnauthorized: true` against the RDS CA bundle; refused without a CA | Unit tests |
| Login role over-privileged | `tracker_app`: no password, `NOINHERIT`, owns nothing, no `BYPASSRLS`; must `SET LOCAL ROLE` into an app role per transaction | DB test (`login-role`) |
| Master secret misuse | Used only by the migration task; RDS-managed and rotated; read through the task's identity | Accepted in `security-decisions.md` |

## Security acceptance criteria per milestone

- **M0:** CI gates run and fail on planted issues (gitleaks proven). RLS is closed by default.
- **M1:** forged, tampered, replayed and oversized requests are rejected in tests. CodeQL is clean.
- **M2:** cross-team access and Viewer writes fail in DB tests.
- **M3:** runbook markdown cannot inject scripts (test with a `<script>` payload).

### Health endpoint (M0)

| Threat | Mitigation |
| --- | --- |
| Information disclosure | Fixed body with no error text. Logs hold the error code only |
| Denial of service | DB connect and query timeouts of 2 seconds. The pool is capped at 10 |

### Live AWS stack (M6)

| Threat | Mitigation | Test |
| --- | --- | --- |
| Direct access to the app, load balancer or database from the internet | Internal load balancer reached only through a CloudFront VPC origin; tasks accept only the load balancer; database accepts only the tasks; no ingress from any CIDR range | Terraform tests, Conftest |
| Eavesdropping on viewers | CloudFront redirects HTTP to HTTPS; the app sets HSTS | Terraform test |
| Swapped or tampered image | ECR tags immutable; deploys use signed digests (M6-C) | Terraform test, Conftest |
| Stolen deploy credentials | GitHub OIDC, role trusts only the `production` environment of this repository; no stored keys | Terraform test |
| Over-privileged tasks | Separate execution and task roles per job; `rds-db:connect` only as `tracker_app`; SES only from the one identity | Code review |
| Spoofed client address (rate limits) | Leftmost `X-Forwarded-For` is client-controlled behind CloudFront | **Accepted gap**, see security decisions |
| Silent failure | Alarms on 5xx, no healthy task, DB CPU and storage, worker heartbeat silence; all email the owner | Live check in M6-D |
| Runaway cost | $1 budget with alerts at 50/80/100% and forecast; the stack is destroyed after the window | Applied 2026-11-13 |

## Change log

- 2026-11-13: M6-B added the live stack (CloudFront VPC origin, internal load balancer, Fargate, RDS), GitHub OIDC deploy role, alarms and Conftest policies.
- 2026-11-13: M6-A added IAM database auth, the `tracker_app` login role and the SES email provider.
- 2026-10-27: added the health endpoint (T2).
- 2026-10-27: added the migration runner, the app role and RLS closed by default (T3).
- 2026-10-27: added the Terraform skeleton and budget alert (T4).
- 2026-10-28: added CI and supply-chain controls (T5).
- 2026-10-30: added SNS verification, the topic allow-check and the outbound SSRF guard (T9).
- 2026-10-30: added the incident schema, the `app_ingest` role and DB-enforced dedupe (T10).
- 2026-11-06: response checklists are now editable living documents: proposals with review, findings, retire instead of delete.
- 2026-11-01: M3 added runbooks (text-only rendering) and step completions with RLS.
- 2026-11-01: M2 added sessions, dev login, team-scoped RLS for users, and status changes with timeline and audit.
- 2026-11-01: SNS ingestion endpoint live (T11). Body cap of 300 KB, generic errors, ids-only logs. End-to-end tests cover forged and duplicate alerts. Rate limiting is still open (M5, not built), so a flood of *verified* alerts is bounded only by dedupe.

- 2026-10-26: first draft (M0).
