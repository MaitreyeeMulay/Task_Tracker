# Security decisions

Each finding is **fixed**, **suppressed** (with a written reason) or **accepted** (with an expiry date). Target fix times: critical within 7 days, high within 30 days.

| Date | Finding / tool | Severity | Decision | Reason | Expiry |
| --- | --- | --- | --- | --- | --- |
| 2026-10-26 | Dev login has no lockout (design) | Medium | Accepted | M5 is out of scope. The dev login is disabled in production and only reachable locally | Before any deployment |
