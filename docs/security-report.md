# Security report

M7 deliverable (`SPEC.md`). Each control has one status:

- **CI:** a check that runs on every pull request and blocks the merge if it fails.
- **Policy:** enforced by configuration outside the test suite, such as a GitHub rule, a deploy-time check or a database rule.
- **Manual:** relies on a person or a review. Nothing fails automatically.
- **Not done:** designed or wanted, but not in place.

"Verified live" means it was also seen working on AWS during the one live window (2026-11-16, see `docs/decisions.md`). Findings are listed at the end. Their full reasons are in [`security-decisions.md`](security-decisions.md).

_As of 2026-11-19._

## Supply chain and CI

| Control | Status | Evidence |
| --- | --- | --- |
| Secret scanning over the full git history (gitleaks, binary pinned by SHA-256) | CI | `ci.yml` "Secret scan"; shown failing on a planted secret in M0 |
| Third-party actions pinned to a commit SHA; Docker images in workflows pinned by digest | CI | `src/repo/workflows.test.ts`, `src/repo/workflow-policy.ts` |
| Minimal workflow token permissions; no `write-all`; no `pull_request_target` | CI | Same test |
| Static analysis (CodeQL `security-extended`, JavaScript/TypeScript and workflows) | CI | `codeql.yml`; required check. Blocked two real findings (PR #19, PR #28) |
| Dependency audit, fails on critical | CI | `npm audit --audit-level=critical` |
| Image scan: fails on high or critical with a fix | CI | Trivy in `ci.yml`; raised from critical to high in M7. 0 high and 0 critical as of #37 |
| No package manager in the runtime image | CI | `ci.yml` "Runtime image has no package manager"; shown failing first (#37) |
| SBOM for every image (CycloneDX) | CI | Syft in `ci.yml`, published as a build artifact |
| Infrastructure as code checks: fmt, validate, tests, tflint, Checkov, Conftest with Rego unit tests | CI | `ci.yml` Terraform job; `infra/tests/stack.tftest.hcl` (10 runs); `policy/terraform` |
| Base image in the Dockerfile pinned by digest | Manual | Pinned and kept current by Dependabot; no test fails if the pin is removed |
| Dependency updates (npm, Actions, Docker, Compose, Terraform) | Policy | `.github/dependabot.yml`, weekly; CodeQL action updates grouped |
| Branch protection: PR required, all checks and code scanning must pass, no force push, no admin bypass | Policy | GitHub ruleset. Requires 0 approvals, because the repo has one maintainer (accepted) |
| New dependencies reviewed before adding | Manual | CLAUDE.md rule; reasons in `docs/decisions.md` |

## Deployment

| Control | Status | Evidence |
| --- | --- | --- |
| Only images signed by this repository's deploy workflow on `main` are deployed (cosign keyless) | Policy | `deploy.yml` verifies before any change. Signing and verification ran live. **Rejecting an unsigned image was never triggered** (accepted; `docs/future-work.md`) |
| Task definitions checked before registering: image by digest from our ECR, read-only root, not privileged, no secrets in plain env | Policy | `policy/deploy` Conftest with Rego unit tests; ran live |
| Deploys need the owner's approval and come only from `main` | Policy | GitHub `production` environment; verified live |
| No stored cloud keys: GitHub OIDC, trust limited to the `production` environment by immutable repository id | Policy | Terraform test; verified live (#33) |
| One-off steps (migrations) are never retried automatically | Policy | `scripts/deploy/run-once.sh` |

## Application

| Control | Status | Evidence |
| --- | --- | --- |
| Row-level security on every table, closed by default; the app role doesn't own tables and can't bypass RLS | CI | `test/db/schema-security.test.ts` |
| Team scoping: users see only their teams; Viewers can't write | CI | `test/db/team-scoping.test.ts` (M2 "done when") |
| Audit log is append-only, even for the owner; users' rows can only name their own teams | CI | `test/db/schema-security.test.ts`, `team-scoping.test.ts` (migration 0013, M7) |
| Every change and every export is audited; only team admins can read or export | CI | `test/db/audit-export.test.ts` |
| SNS alerts: AWS signature verified, topic must match, forged rejected, duplicate and replayed messages change nothing | CI | `src/ingest/sns.test.ts`, `test/db/ingest-e2e.test.ts` |
| SSRF guard: outbound calls only to `sns.<region>.amazonaws.com` over https, no redirects, 15 s timeout | CI | `src/ingest/sns-http.test.ts` |
| Request body cap (300 KB) and per-integration rate limit on ingestion | CI | `src/ingest/sns-handler.test.ts`, `src/security/security.test.ts` |
| Password hashing (scrypt, salted, parameters bounded) | CI | `src/security/security.test.ts` |
| Lockout after 5 failures for 15 minutes; same answer for unknown users (no enumeration) | CI | `test/db/login.test.ts` |
| Login rate limits per address and per email | CI | `src/security/security.test.ts`. Behind CloudFront the per-address limit can be dodged (accepted until 2026-12-31) |
| OIDC sign-in: PKCE, state, nonce; existing users only; links only a verified email | CI | `test/db/oidc.test.ts` against a fake provider |
| Sessions: HMAC-signed, HttpOnly, Secure, SameSite=Lax, 8 hours, two secrets for rotation | CI | `src/auth/session.test.ts` |
| Revoking one session (sign out everywhere, end sessions on lockout) | **Not done** | Stateless sessions; rotating the secret ends all of them (accepted, M7) |
| CSRF: cross-site state-changing requests refused | CI | `src/security/security.test.ts`, plus SameSite cookies and Next.js Origin checks |
| Security headers: nonce CSP, HSTS, no framing, nosniff, referrer and permissions policies | CI | `src/security/security.test.ts`; verified live |
| Checklist Markdown can't inject HTML or scripts | CI | `src/runbooks/markdown.test.ts` (`<script>` payload) |
| Dev login can never be on in production; unknown environment means production | CI | `src/lib/config.test.ts`; verified live |
| Notifications: nothing lost or sent twice across crashes; ambiguous sends go to a person | CI | `test/db/worker.test.ts` (mid-timer and mid-send crash tests) |
| Logs hold ids and counts only, never personal data or bodies | Manual | Code review (M7). One test covers ingestion (`ingest-e2e`: "logs ids and outcomes only") |
| External calls behind an interface with a development stub, with timeouts | Manual | Code review (M7): SNS, SES |

## Cloud (AWS, M6)

| Control | Status | Evidence |
| --- | --- | --- |
| Database private, encrypted, IAM authentication, TLS enforced and verified against the RDS CA | CI | Terraform test; `src/lib/db-connection.test.ts`; verified live (port 5432 unreachable) |
| Nothing accepts traffic from the whole internet except CloudFront; internal load balancer | CI | Terraform test and Conftest; verified live |
| Viewers use HTTPS only | CI | Terraform test; verified live (HTTP redirects) |
| ECR: immutable tags, scan on push | CI | Terraform test |
| Alarms as code (5xx, no healthy task, DB CPU and storage, worker silence) email the owner | Policy | Terraform; verified live (the app-unhealthy alarm emailed) |
| Monthly cost budget with alerts | Policy | Applied 2026-11-13, still in place |
| Dynamic scan (OWASP ZAP baseline, fail on high) | **Not done** | No job built (accepted; design in `docs/future-work.md`) |
| Timed restore drill | **Not done** | Point-in-time restore enabled; never timed (accepted) |
| WAF, customer-managed KMS keys, Multi-AZ, access logs | **Not done** | Over the $1 budget for a short demo window (accepted, Checkov skips with reasons) |

## Findings

All findings are in [`security-decisions.md`](security-decisions.md), with dates, severities, reasons and expiries. Summary as of 2026-11-19:

| Outcome | Findings |
| --- | --- |
| **Fixed** | CodeQL `js/insecure-randomness` (high, #19) · CodeQL `js/clear-text-logging` (high, #28) · `minimatch` DoS (moderate, override) · 6 HIGH in the image's bundled npm (#37) · audit rows into other teams (low, migration 0013) |
| **Closed** | Dev login without lockout (disabled in production, verified live) · OSV-Scanner gap (Trivy now covers OS packages) |
| **Accepted, with expiry** | Leftmost `X-Forwarded-For` behind CloudFront (2026-12-31) · RDS master secret for migrations (2027-05-13) · Checkov skips for cost (before any long-lived deployment) · stateless sessions (before multi-user production use) · CSRF without Origin or Sec-Fetch-Site (2027-05-19) · no ZAP, no restore drill, no live unsigned-image rejection (before any further deployment) · 0 required approvals (until a second maintainer) · Dependabot ignores TypeScript ≥ 6.1 (2026-12-31) |
| **Open** | None |
