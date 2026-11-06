-- 0010: M5 OIDC sign-in. Additive: one nullable, unique column linking a user
-- to their identity-provider subject ("<issuer>|<sub>"), set on first OIDC login
-- by a verified email. app_auth may read and set it, nothing more.

ALTER TABLE users ADD COLUMN oidc_subject text UNIQUE CHECK (length(oidc_subject) BETWEEN 3 AND 600);
GRANT SELECT (oidc_subject) ON users TO app_auth;
GRANT UPDATE (oidc_subject) ON users TO app_auth;
