# Security decisions

Each finding is **fixed**, **suppressed** (with a written reason) or **accepted** (with an expiry date). Target fix times: critical within 7 days, high within 30 days.

| Date | Finding / tool | Severity | Decision | Reason | Expiry |
| --- | --- | --- | --- | --- | --- |
| 2026-10-26 | Dev login has no lockout (design) | Medium | Accepted | M5 is out of scope. The dev login is disabled in production and only reachable locally | Before any deployment |
| 2026-10-28 | Checkov threshold (gate design) | n/a | Changed to stricter | Free Checkov has no severities, so the gate fails on any failed check instead of only high | n/a |
| 2026-10-28 | OSV-Scanner replaced by `npm audit --audit-level=critical` (gate design) | n/a | Accepted | Same critical threshold, and the spec allows either tool. Container OS packages are not covered until Trivy (M5, not built) | Before any deployment |
| 2026-10-28 | Dependabot ignores TypeScript `>=6.1` | Low | Accepted | TypeScript 7 breaks `npm ci` (typescript-eslint peer range). No security fixes are skipped: 6.0.x patches still arrive | 2026-12-31 |
