# Decisions and trade-offs

Newest first. Each entry gives the decision, the reason and the trade-off.

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
