# Incident and runbook tracker

Turns monitoring alerts into incidents, guides responders with runbooks and keeps an audit trail. It is built to show DevSecOps practice end to end. See [`SPEC.md`](SPEC.md).

**Status:** M0 done. M1 next. The build scope is M0 to M3. M4 to M6 are designed but not built (see [`docs/decisions.md`](docs/decisions.md)).

## Run it locally

Requires Node 24 or newer, and Docker for the database (from T2).

```sh
npm ci
npm run typecheck   # TypeScript, strict
npm run lint        # ESLint, zero warnings allowed
npm test            # unit tests (Vitest)
```

### Docker stack

```sh
cp .env.example .env          # then set POSTGRES_PASSWORD (and DATABASE_URL to match)
docker compose up -d --build  # Postgres 17 + app, bound to 127.0.0.1 only
curl -m 15 http://127.0.0.1:3000/api/health
# {"status":"ok","db":"ok"}  -> HTTP 200
# {"status":"degraded","db":"down"} -> HTTP 503 when Postgres is unreachable
```

The image is a multi-stage build that runs as the non-root `node` user. The base images are pinned by digest, and dependencies are installed with `--ignore-scripts`. The first start of the `db` volume also creates `incident_tracker_test` for the database tests.

### Migrations and database tests

```sh
npm run migrate   # applies migrations/ to DATABASE_URL (from .env)
npm run test:db   # needs the compose db running: docker compose up -d db
```

- Migrations are plain SQL files `migrations/NNNN_name.sql`. Each runs in its own transaction and is recorded in `schema_migrations` with a SHA-256 checksum.
- The runner refuses to continue if an applied file was edited or deleted, or if a new file is older than the latest applied one. An advisory lock stops two runners from overlapping.
- Database tests use `<db>_test`, derived from `DATABASE_URL` or set with `TEST_DATABASE_URL`. They refuse any database whose name doesn't end in `_test`. Each test runs in a transaction that is rolled back.

**What the database tests prove (M0):**
- The app role `app_rw` is not a superuser, cannot bypass RLS and owns no tables.
- Every table has RLS enabled and forced. With no policies yet, the app role reads 0 rows and cannot insert.
- `audit_log` is append-only: the app role can insert but not read, update or delete it. Update, delete and truncate are blocked by a trigger, even for the owner.

### Infrastructure (Terraform)

`infra/` holds the AWS configuration. In M0 it contains one resource: a **monthly cost budget** that emails at 50%, 80% and 100% of actual spend and 100% of forecast. It comes first so cost is guarded before anything else is deployed.

```sh
cd infra
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform test     # plan-only, mocked AWS provider: no credentials, nothing created
```

Nothing has been applied. To create the budget in your own account, copy `terraform.tfvars.example` to `terraform.tfvars` (git-ignored), set your email, then run `terraform apply` with your own credentials. tflint and Checkov run in CI.

## CI and security gates

Every push to `main` and every pull request runs two workflows. All third-party actions are pinned to a commit SHA. The token is read-only by default, and only the CodeQL job gets `security-events: write`.

| Job (`.github/workflows/ci.yml`) | What it checks | Fails on |
| --- | --- | --- |
| Typecheck, lint, unit tests | `tsc`, ESLint (zero warnings), Vitest | any error |
| Database tests (Postgres) | RLS and audit tests on a Postgres 17 service container | any failure |
| Docker image build | the production image builds | build error |
| Terraform | `fmt -check`, `validate`, `terraform test`, tflint, Checkov | any finding |
| Secret scan | gitleaks over the **full git history** (binary pinned by SHA-256) | any finding |
| Dependency audit | `npm audit --audit-level=critical` | critical |

| Workflow | What it checks |
| --- | --- |
| `codeql.yml` | CodeQL `security-extended` for JavaScript/TypeScript and for the workflows themselves. Also runs weekly. |
| `dependabot.yml` | Weekly updates for npm, GitHub Actions, Docker, Compose and Terraform. |

A unit test (`src/repo/workflows.test.ts`) fails if any workflow uses an unpinned action or an undigested Docker image, lacks top-level `permissions`, uses `write-all`, or uses `pull_request_target`.

**Verified:** all 6 CI jobs and both CodeQL analyses passed on `main` at `1ea1f00` (2026-10-27). A Dependabot pull request bumping TypeScript to 7.0.2 was correctly blocked: `npm ci` failed on a peer-dependency conflict.
**Gate proof (2026-10-28):** PR #2 planted a fake API key. The required secret scan failed, every other check passed, and the PR could not be merged. `main` is protected by the `protect-main` ruleset (see `docs/github-setup.md`).

## Milestones

| # | Status | Notes |
| --- | --- | --- |
| M0 Foundation | Done | CI green, gates proven, `main` protected |
| M1 Ingestion | Not started | |
| M2 Incidents and team scoping | Not started | |
| M3 Runbooks | Not started | |
| M4 to M6 | Designed, not built | |

## Security

- Threat model: [`docs/threat-model.md`](docs/threat-model.md)
- Security decisions: [`docs/security-decisions.md`](docs/security-decisions.md)
- Reporting: [`SECURITY.md`](SECURITY.md)

## Verified versus untested

_Every claim here is either backed by a test or marked untested. This section is filled in as milestones finish._
