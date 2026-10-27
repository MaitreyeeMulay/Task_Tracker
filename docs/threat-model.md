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
| SSRF | Malicious SNS `SubscribeURL` | Host allow-list. Confirmation goes behind an interface (stubbed in dev) | Non-AWS host is rejected |

### Team data and the database (M0, M2)

| Threat | Mitigation | Acceptance test |
| --- | --- | --- |
| Cross-team read or write | RLS enabled and forced on every team table, closed by default. User context set with `SET LOCAL` per transaction | Without context, 0 rows. Cross-team query returns 0 rows |
| Viewer writes | RLS write policies exclude Viewers | Viewer UPDATE fails |
| Audit tampering | The app role gets INSERT only on `audit_log` | UPDATE/DELETE on `audit_log` fails |
| SQL injection | Parameterised queries only, plus CodeQL | CodeQL is clean |

### Web app and auth (M2, M5)

| Threat | Mitigation | Status |
| --- | --- | --- |
| Dev login used in production | Disabled by config, with a test | Planned (M2) |
| Brute force on dev login | Lockout | **Not built (M5 is out of scope).** Accepted: the dev login is only reachable locally |
| CSRF | SameSite cookies, CSRF token | Partly in M2 (SameSite). Full token in M5, not built |
| XSS in runbook markdown | Raw HTML disabled in the renderer | Planned (M3) |

### CI and supply chain (M0)

| Threat | Mitigation | Gate |
| --- | --- | --- |
| Secret committed | gitleaks in CI, GitHub push protection | Fails on any finding |
| Malicious or compromised action | Actions pinned to a SHA, Dependabot for actions | Review |
| Over-privileged token | `permissions: contents: read` by default | Review |
| Vulnerable dependency | OSV-Scanner, Dependabot | Fails on critical |
| Risky IaC | Checkov, tflint | Fails on high |
| Fork pull request steals secrets | No secrets in PR workflows, no `pull_request_target` | Review |

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

## Change log

- 2026-10-27: added the health endpoint (T2).

- 2026-10-26: first draft (M0).
