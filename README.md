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

_Docker stack and database tests are added in T2/T3._

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
