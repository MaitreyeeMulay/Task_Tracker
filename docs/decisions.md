# Decisions and trade-offs

Newest first. Each entry gives the decision, the reason and the trade-off.

## 2026-11-06: Runbooks become living "response checklists" (owner request)

The owner pointed out that "runbook" often means an executed workflow, and that a team should be able to record what actually helped. Agreed changes and the reasoning behind them:

- **Name:** "Response checklist" in everything users see (UI, docs). The table stays `runbooks`, because renaming it would break the previous code version, which `CLAUDE.md` forbids. Code types keep the old module path (`src/runbooks/`).
- **Steps became rows with stable ids** (`checklist_steps`). Before this, completions pointed at a step's *position* in the Markdown, so editing the document would have made old completions point at the wrong step. Steps are **retired, never deleted**, so history stays correct. Migration 0005 backfilled steps and completions from the old data; the old tables are kept for the previous code version.
- **Findings:** each completed step can carry a note ("error rate 12%, deploy #482"), shown on the checklist and the incident timeline.
- **Learning loop with review:** resolving asks "what fixed it?" (stored as `incidents.resolution_note` and on the timeline). It can be **proposed** as a new step, linked to the incident. A team responder or admin then accepts or rejects it, and accepted steps show "learned from <incident> by <person>". Nothing changes the checklist automatically mid-incident, because edits made under pressure tend to add bloat and untested steps.
- **Editing in the app:** create checklists for your team's services, edit the document, add or retire steps, and review proposals. RLS limits all of this to the team's admins and responders.
- **Not built yet** (noted for later): per-step "helped / didn't help" statistics, and flagging repeated alarms that have no checklist (cheap, since alarms are fingerprinted).
- **Mistake during this work:** the first draft of migration 0005 named a column `position`, which is a reserved word in that SQL context. The migration failed and was rolled back, so nothing was recorded. A dry run inside a rolled-back transaction showed the real error, and the column is now `sort_order`.

## 2026-11-01: M3 runbooks (re-added to scope by the owner after M2 worked)

- **Markdown without HTML:** a small in-repo reader (`src/runbooks/markdown.ts`) turns runbook Markdown into plain-text blocks that React renders as text. No HTML is ever produced, so script injection isn't possible, and there's no Markdown/sanitizer dependency. A test confirms `<script>` and `<img onerror>` stay literal text. It supports headings, paragraphs, lists, code blocks and `- [ ]` checklist steps (at most 100).
- **Runs:** one `runbook_runs` row per runbook per incident, created by the first completed step. `runbook_step_completions` has primary key `(run_id, step_index)`, so a step can't be completed twice. It's append-only by trigger. Each completion also writes a `runbook_step` timeline event and an audit row.
- **Scoping:** a runbook opens only from an incident of the same service. RLS limits reads to the user's teams and writes to admins/responders, with `started_by`/`completed_by` required to be the acting user. The timeline insert policy was extended to allow `runbook_step`.
- **Authoring:** runbooks come from the seed script. No editor screen was built, to save time.

## 2026-11-01: M2 incidents UI and team scoping

- **Roles are per team** (`memberships.role`: admin, responder, viewer; default viewer). The spec didn't say whether roles were global or per team. Per team is the more flexible choice, and it was made to keep moving. Changing it later would be an additive migration.
- **Team scoping lives in RLS** (`0003_team_policies.sql`). Every user query runs as `app_rw` with `app.user_id` set per transaction (`withUser`). Policies limit reads to the user's teams, and limit incident updates and timeline inserts to admins and responders. Viewers match no write policy. Membership rows are visible only to their owner, which keeps the "my teams" lookup non-recursive.
- **Users can read only their own profile.** The timeline therefore stores the actor's display name on each event (`data.actor_name`) instead of joining to `users`.
- **Status rules** (`src/incidents/status.ts`): forward only, steps may be skipped, resolved is final. Updates use `WHERE status = <old>`, so a concurrent change gives a "conflict" and is never retried automatically.
- **Sessions:** a stateless HMAC-signed cookie (`tracker_session`): HttpOnly, SameSite=Lax, Secure in production, 8 hours, with two secrets for rotation. No new dependency.
- **Dev login:** email only, no password. It's disabled in production by config. The email lookup is the one query that runs before a user is known, so it doesn't go through `withUser`. Production sign-in (OIDC) and lockout are M5, not built.
- **CSRF:** status changes are Next.js server actions (POST only, Origin checked against Host) with a SameSite=Lax cookie. Token-based CSRF was M5 (not built).
- **UI:** plain CSS, no UI library. Works at phone width and in dark mode.

## 2026-11-01: Scope cut (owner decision)

- After a week against a 2-day plan, the owner cut scope: **finish M1 and M2. M3 (runbooks) becomes "designed, not built"**, like M4–M6.
- Claude now opens PRs and sets them to auto-merge (squash) through the GitHub CLI once required checks pass. No rule bypass, no direct pushes to `main`.

## 2026-11-01: T11 SNS ingestion endpoint

- **Endpoint:** `POST /api/ingest/sns/{integrationId}`. Body capped at 300 KB (SNS max 256 KB), checked against `Content-Length` and while streaming.
- **Responses:** 413 too large, 400 bad JSON, 404 unknown or inactive integration, 403 failed verification (generic body, reason logged), 422 verified but not a CloudWatch alarm, 202 ignored state, 201 incident opened, 200 updated / cleared / re-delivered, 502 subscription confirm failed, 500 generic.
- **Transactions:** the integration lookup and the ingest each run in their own short transaction as `app_ingest`. No transaction stays open during the certificate download.
- **Logs:** ids, outcomes and reasons only. A test checks that payload text never appears.
- **Subscription confirmation** is live only in production and stubbed elsewhere.
- **Generic HMAC webhook endpoint: not built** (scope). The verifier (T8) is built and tested. Wiring it needs the Secrets Manager client, so it's left as documented future work.
- **End-to-end test** (`test/db/ingest-e2e.test.ts`) runs the M1 criteria through the real handler, real signature verification and real Postgres: a sample alert opens an incident, a duplicate doesn't, a forgery is rejected and stores nothing. It was written after the parts it connects, so it was not shown failing first.

### Incident: corrupted file in `node_modules/zod`
- Lint crashed on a syntax error in `node_modules/zod/v4/locales/en.cjs`. A diff against the official 4.6.7 tarball showed one changed line (`const` garbled to `i    conat`) and no other differences. That looks like an accidental edit or sync corruption, not tampering, since it broke the code rather than adding behaviour. Fixed by reinstalling from the registry (integrity-checked against the lockfile). CI uses a clean `npm ci`, so it was never affected.

## 2026-10-30: T10 incident schema (owner approved both recommendations)

### Integration secrets live in AWS Secrets Manager
- `integrations.secret_ref` holds only a Secrets Manager name or ARN. The database never stores a signing secret, and a test fails if a secret-like column appears. SNS integrations store their topic ARN instead, which the T9 topic check uses.

### Separate `app_ingest` database role for the webhook path
- No user is behind an incoming alert, so ingestion uses its own role. It can read active integrations and services, insert alerts, open incidents (status `triggered` only), bump `alert_count` and `last_alert_at` on **open** incidents (column-level grant), and write `alert_received`/`alert_resolved` timeline and audit rows.
- It cannot read users, memberships or the audit log, change integrations, resolve incidents, or delete anything. Each of these is a DB test.

### Dedupe enforced in the database
- A partial unique index allows one open incident per `(service_id, fingerprint)`. Even concurrent duplicate alerts can't open two incidents. `(integration_id, external_id)` is unique, so an SNS retry of the same MessageId is a no-op.
- `incidents (service_id, team_id)` references `services (id, team_id)`, so an incident can't be filed under a team that doesn't own the service.

### Cleared alarms do not auto-resolve incidents
- A CloudWatch `OK` adds an `alert_resolved` timeline entry. A person still resolves the incident, which keeps responders in charge. The ingest role is unable to resolve.

### Mistake during T10
- My first draft used `{1,256}` in a CHECK regex, which exceeds Postgres's limit of 255. It only failed when rows were checked, after the migration was recorded in the **test** database. The checksum guard then correctly refused the corrected file. The migration had never been committed or applied to dev, so I fixed it and recreated `incident_tracker_test`. Lesson: DB tests must insert at least one row through every CHECK constraint, which the T10 tests now do.

## 2026-10-30: T9 SNS signature verification

- Follows AWS's documented procedure: rebuild the string to sign from the fields in a fixed order, then RSA-SHA256 verify with the certificate from `SigningCertURL`. **SignatureVersion 1 (SHA-1) is rejected.**
- **The topic must match the integration's configured topic ARN.** A valid AWS signature only proves AWS sent the message, and anyone can create an SNS topic and subscribe our endpoint to it. This was not in the original plan, and was added because without it the signature check proves nothing about who owns the alarm.
- **Order of checks:** shape, then topic, then signature version, then certificate URL, and only then a network fetch. A message we'd reject never causes an outbound request.
- **Outbound calls** (certificate fetch, subscription confirm) sit behind function interfaces. A development stub doesn't touch the network. The real version allows only `https://sns.<region>.amazonaws.com(.cn)` with no port or user info, applies a 15-second timeout, refuses redirects, caps certificates at 16 KB, and caches up to 20 certificates. Failures are never cached.

## 2026-10-28: T8 webhook signatures

- **Scheme:** `X-Timestamp` (unix seconds) and `X-Signature: v1=<hex HMAC-SHA256(secret, "<ts>.<raw body>")>`. Signing the timestamp stops it being changed to dodge the replay window.
- **Rotation:** up to two secrets are valid at once (current and previous). Add the new one, update the sender, then remove the old one, with no downtime. More than two, an empty list, or a secret under 32 characters is a configuration error.
- **Replay:** requests more than 5 minutes old or in the future are rejected. A replay inside the window is caught by fingerprint dedupe (T10/T11).
- **Timing:** constant-time comparison (`timingSafeEqual`), and every configured secret is always checked.

## 2026-10-28: T7 CloudWatch alarm parsing

- **Fingerprint** = SHA-256 of the alarm ARN. The ARN is unique per alarm and already covers account, region and the alarm's fixed dimensions, so repeats of the same alarm match whatever the state, reason or time.
- **Severity:** CloudWatch has none, so it's read from a `SEV1`–`SEV4` tag in the alarm description (for example `[SEV2] ...`), defaulting to SEV3. Easy to change if the owner prefers another rule.
- **States:** `ALARM` means firing, `OK` means resolved. `INSUFFICIENT_DATA` is ignored, so missing metrics never page anyone.
- **Untrusted input:** validated with `zod` (4.6.7, no dependencies, MIT). Only the fields we use are checked, with length limits. Errors name the failing fields, never their values.

## 2026-10-28: T6 GitHub setup

### A ruleset instead of classic branch protection
- **Why:** only rulesets support "Require code scanning results", which is the gate that makes CodeQL fail pull requests on high or above. The settings are written down in `docs/github-setup.md`, because they can't be stored as code in this repo.

### PR required with 0 approvals (owner's decision, 2026-10-28)
- **Why:** this is a solo repo, and GitHub doesn't let authors approve their own PRs. Requiring 1 approval would force an admin bypass on every change, which is weaker than an honest 0 with no bypass.
- **Trade-off:** there is no second pair of eyes, so the automated checks carry the weight. Revisit when a collaborator joins.

### The gate proof uses a fake secret generated at run time
- The planted value is created by a command when the proof is run, so it never sits in any committed file. Otherwise gitleaks would flag the instructions themselves on `main`.

## 2026-10-28: T5 CI and security gates

### Checkov fails on any failed check, not only "high"
- **Why:** open-source Checkov reports no severities without a paid Prisma Cloud API key, so `--hard-fail-on HIGH` can't work. Failing on everything is stricter than the spec's threshold. Any skip needs an inline `#checkov:skip=<id>:<reason>` and an entry in `security-decisions.md`.

### `npm audit` is the dependency gate instead of OSV-Scanner
- **Why:** SPEC.md allows "npm audit or OSV-Scanner". `npm audit --audit-level=critical` gives the spec's exact threshold with no extra tool. OSV-Scanner v2 has no equally simple severity threshold.
- **Trade-off:** it only covers the npm advisory database. Container OS packages get Trivy in M5 (designed, not built).

### Scanners run as pinned binaries or digests, not third-party actions
- gitleaks is downloaded from its release and verified against a SHA-256 written into the workflow. Checkov runs as a Docker image pinned by digest.
- **Why:** fewer third-party actions holding the job token, and a swapped release asset fails the checksum.

### CodeQL also scans the workflows
- The `actions` language finds injection risks in workflow files themselves, such as untrusted `${{ }}` input inside `run:`.
- **Gate:** CodeQL uploads results but doesn't fail the job itself. The "fail on high or critical" gate is a GitHub code-scanning merge rule, set up in T6.

### CI database uses trust auth
- The Postgres service container in CI uses `POSTGRES_HOST_AUTH_METHOD=trust`. It's a throwaway database on the runner, so there's no password to manage or leak, and nothing secret-looking for gitleaks to flag.

### Dependabot: TypeScript held below 6.1
- Dependabot's TypeScript 7.0.2 pull request failed CI (`npm ci` peer conflict with typescript-eslint, which supports `<6.1`). An `ignore` rule stops it being proposed again.
- **Lift when** typescript-eslint supports TypeScript 7. Check monthly. Tracked in `security-decisions.md` with an expiry date.

## 2026-10-27: T4 Terraform skeleton

### The first resource is a budget alert
- **Why:** SPEC.md requires a budget alert before anything is deployed. Budgets without actions are free under AWS pricing at the time of writing. Check again before applying.
- The alert email is a `sensitive` variable with no default. It lives only in a git-ignored `terraform.tfvars`.

### Terraform tests with a mocked provider
- `terraform test` with `mock_provider "aws"` and `command = plan` checks the budget's type, limit, thresholds and recipient, and that validation rejects bad input. It needs no AWS credentials, so it runs in CI and on any laptop.
- **Trade-off:** mocks don't prove AWS accepts the config. That's only proven by a real `apply`, which is marked untested until the owner runs it.

### Provider pinned exactly, lock file committed
- `hashicorp/aws = 6.70.0`. The lock file holds hashes for `linux_amd64` (CI) and `windows_amd64` (local). Add more platforms with `terraform providers lock -platform=...` if a contributor needs them.

### Local state for now
- No `apply` runs from CI yet. M6 design: an S3 backend with encryption, versioning and locking, with CI signing in through GitHub OIDC.

### Region `eu-west-2` (London)
- An assumed default. The owner can change it with the `region` variable.

## 2026-10-27: T3 migrations and first schema

### In-repo migration runner with checksums
- **Why:** no extra dependency, and the rules are ours and tested: editing an applied migration, deleting one or adding one out of order all stop the run. Checksums normalise line endings because the repo lives on Windows and OneDrive.
- **Trade-off:** no down migrations. That's deliberate: changes are additive, so the previous code version keeps working.

### Scripts run as TypeScript directly on Node 24
- `node scripts/migrate.ts` uses Node's built-in type stripping, so there's no `tsx` or `ts-node` dependency. To keep this safe, `tsconfig` now sets `allowImportingTsExtensions`, `verbatimModuleSyntax` and `erasableSyntaxOnly`, so typecheck rejects syntax Node can't strip.

### App role `app_rw` is NOLOGIN
- **Why:** a migration must never contain a password. Each environment creates its own login role and grants it `app_rw`: in M2 for local use, and through IAM database auth in the cloud design.
- **For now:** the app still connects as the compose superuser, and the health check only runs `SELECT 1`. **This must change before the app queries team data (M2, T14).**

### RLS closed by default, team policies in M2
- Every table has RLS enabled and forced with no read policies. Tests prove the app role sees 0 rows. A catalog test fails if any future table lacks RLS.

### Roles on memberships deferred to M2
- **Open question for the owner:** SPEC.md doesn't say whether Admin, Responder and Viewer are global or per team. The column will be added additively in M2 with a safe default (`viewer`) once this is answered.

### audit_log append-only through grants and triggers
- The app role gets INSERT only. Triggers block UPDATE, DELETE and TRUNCATE for everyone, including the owner.
- **Limit:** a superuser can still disable the triggers. That's accepted: the cloud design never gives the app a superuser.
- The audit insert policy is `WITH CHECK (true)`, which lets anyone holding `app_rw` write any audit row. It's tightened in M2 so `actor_user_id` must equal the current user.

## 2026-10-27: T2 health check and Docker stack

### Health endpoint returns 503 when the database is down
- **Why:** load balancers and uptime checks can act on the status code. The body is fixed (`status`, `db`) and never contains error text.
- **Trade-off:** the endpoint is unauthenticated and reveals whether the database is up. That is low risk, and normal for health checks.

### DB errors are logged by code only
- **Why:** pg error messages can contain host and user names. Logs record `{event, code}` (project rule: log ids and counts, not details).

### Container hardening
- Multi-stage build with Next.js `standalone` output, so the runtime image has no dev dependencies or source.
- Runs as the non-root `node` user. `npm ci --ignore-scripts` stops dependencies running code at build time.
- Base images are pinned by digest. Compose ports bind to `127.0.0.1` so the DB is not exposed on the LAN.
- **Trade-off:** digest pins go stale. Dependabot (T5) will raise update pull requests.

### Separate test database created by an init script
- `db/init/01-create-test-db.sql` creates `incident_tracker_test` when the volume is first created. **Caveat:** an existing volume doesn't re-run init scripts. In that case, run `docker compose down -v` to recreate it, which deletes dev data.

## 2026-10-27: T1 toolchain

### TypeScript pinned to 6.0.3, not 7.0
- **Why:** typescript-eslint 8.72 supports TypeScript `>=4.8.4 <6.1.0`. TypeScript 7 (the native compiler) is outside that range.
- **Trade-off:** we skip the faster compiler for now. We revisit when typescript-eslint supports 7. Dependabot will propose it.

### Exact dependency versions
- **Why:** reproducible builds. Updates arrive as reviewed Dependabot pull requests rather than silent drift.

### `unrs-resolver` install script left blocked
- **Why:** npm's install-script allow-list held back its postinstall, and lint passes without it. Running third-party install scripts is a supply-chain risk, so it stays blocked unless something needs it.

### Dev login can never be enabled in production
- `loadConfig` treats any unknown `NODE_ENV` as production and only accepts `DEV_LOGIN_ENABLED=true` outside production. Tested in `src/lib/config.test.ts`.

## 2026-10-26: Planning decisions

### AWS with Terraform, free tier only
- **Why:** owner's choice. Terraform is widely known and has mature scanners (Checkov, tflint).
- **Trade-off:** free-tier terms change over time and must be checked again before any deployment. Deployment (M6) is out of the build scope for now.

### Alert source: CloudWatch alarms through SNS
- **Why:** it matches the AWS choice. The spec originally named an Azure Monitor adapter.
- **Trade-off:** SNS signs messages with AWS certificates rather than our HMAC secret. We verify both: SNS signatures on the SNS endpoint, and HMAC with two valid secrets on the generic webhook. Confirming an SNS subscription needs an outbound call, so it goes behind an interface with a stub, and the URL is validated to prevent SSRF.

### Auth: dev login plus OIDC in production
- **Why:** local development and tests need no external identity provider. Production uses OIDC.
- **Trade-off:** there are two code paths. The dev login is disabled in production by config, and a test covers that. Lockout belongs to M5, which is not built, so the dev login has no lockout. This is accepted because the dev login is only reachable locally (see the threat model).

### Scope: build M0 to M3, design M4 to M6
- **Why:** there are 2 days available, and a smaller scope done properly with all gates beats every milestone done shallowly.
- **Trade-off:** there is no live deployment, worker, signed images or DAST. These are marked "not done" in the security report.

### Database tests use a Postgres you start
- **Why:** the project rules say Claude never starts or stops containers. You run `docker compose up -d db`, and tests use a separate `test` database and fail fast if it is down. CI uses a service container.
- **Trade-off:** running the tests locally takes one manual step.

### No ORM, plain `pg` and an in-repo migration runner
- **Why:** SQL and row-level security policies stay explicit and reviewable. It also means fewer dependencies.
- **Trade-off:** we write more SQL by hand. The runner is small and unit tested.

### Public repository
- **Why:** a portfolio project. Public repos get CodeQL and secret scanning at no cost on GitHub.
- **Trade-off:** everything is visible, so secret hygiene is enforced by gitleaks in CI and by GitHub push protection.

### Project stays under OneDrive
- **Why:** owner's choice.
- **Risk:** OneDrive sync can lock files in `node_modules` and slow Docker bind mounts. If file-lock errors appear, work stops and the owner is asked.
