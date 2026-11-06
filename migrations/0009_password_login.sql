-- 0009: M5 password login with lockout.
-- Additive: nullable columns on users and a narrow role used only before a
-- user is known (login, dev login lookup). Previous code ignores both.

ALTER TABLE users ADD COLUMN password_hash text CHECK (password_hash LIKE 'scrypt$%' AND length(password_hash) <= 300);
ALTER TABLE users ADD COLUMN failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0);
ALTER TABLE users ADD COLUMN locked_until timestamptz;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO app_auth;

-- Column-level: exactly what a login needs, nothing about teams or incidents.
GRANT SELECT (id, email, password_hash, failed_logins, locked_until) ON users TO app_auth;
GRANT UPDATE (password_hash, failed_logins, locked_until, last_login_at) ON users TO app_auth;
CREATE POLICY auth_read_users ON users FOR SELECT TO app_auth USING (true);
CREATE POLICY auth_update_users ON users FOR UPDATE TO app_auth USING (true) WITH CHECK (true);

-- Logins are audited (ids only).
GRANT INSERT ON audit_log TO app_auth;
CREATE POLICY auth_audit ON audit_log FOR INSERT TO app_auth
  WITH CHECK (action IN ('auth.login_succeeded', 'auth.login_failed', 'auth.locked', 'auth.password_set'));
