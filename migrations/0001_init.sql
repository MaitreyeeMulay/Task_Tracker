-- 0001: teams, users, memberships, audit log.
-- Row-level security is enabled and forced on every table with no policies,
-- so the app role sees nothing until later migrations add team-scoped policies.

-- The app role. NOLOGIN: a login role is granted membership per environment,
-- so no password ever lives in a migration. Roles are cluster-wide, hence the guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw;

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Roles (admin / responder / viewer) are added in M2. See docs/decisions.md.
CREATE TABLE memberships (
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

-- Append-only. Holds ids and actions, never personal data or request bodies.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  team_id uuid,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200)
);
CREATE INDEX audit_log_team_occurred_idx ON audit_log (team_id, occurred_at);

CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Row-level security: on and forced (applies to the table owner too).
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Grants: RLS decides which rows. audit_log gets INSERT only.
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, users, memberships TO app_rw;
GRANT INSERT ON audit_log TO app_rw;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO app_rw WITH CHECK (true);
