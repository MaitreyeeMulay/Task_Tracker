# Incident and runbook tracker

Turns monitoring alerts into incidents, guides responders with runbooks and keeps an audit trail. It is built to show DevSecOps practice end to end. See [`SPEC.md`](SPEC.md).

**Status:** M0 in progress. The build scope is M0 to M3. M4 to M6 are designed but not built (see [`docs/decisions.md`](docs/decisions.md)).

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

_Database tests are added in T3._

## Milestones

| # | Status | Notes |
| --- | --- | --- |
| M0 Foundation | In progress | |
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
