-- 0003: per-team roles and the app_rw row-level security policies (M2).
-- Additive: a new column with a safe default, a helper function, and policies.
-- The one non-additive change tightens audit_log inserts for app_rw, which no
-- previous code version used.

-- Roles are per team (owner decision 2026-11-01). Default is the least privilege.
ALTER TABLE memberships ADD COLUMN role text NOT NULL DEFAULT 'viewer'
  CHECK (role IN ('admin', 'responder', 'viewer'));

-- The acting user, set per transaction by the app (src/db/with-user.ts).
-- NULL when unset, so every policy below matches nothing: closed by default.
CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- memberships: users see only their own rows. Every other policy asks
-- memberships "which teams am I in?", and this keeps that lookup non-recursive.
CREATE POLICY rw_own_memberships ON memberships FOR SELECT TO app_rw
  USING (user_id = app_user_id());

CREATE POLICY rw_own_profile ON users FOR SELECT TO app_rw
  USING (id = app_user_id());

CREATE POLICY rw_member_teams ON teams FOR SELECT TO app_rw
  USING (id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));

CREATE POLICY rw_member_services ON services FOR SELECT TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));

CREATE POLICY rw_member_integrations ON integrations FOR SELECT TO app_rw
  USING (service_id IN (SELECT id FROM services));

CREATE POLICY rw_member_incidents ON incidents FOR SELECT TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));

CREATE POLICY rw_member_events ON incident_events FOR SELECT TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));

-- Writes: admins and responders of the incident's team only. Viewers match nothing.
CREATE POLICY rw_writer_update_incidents ON incidents FOR UPDATE TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships
                     WHERE user_id = app_user_id() AND role IN ('admin', 'responder')))
  WITH CHECK (team_id IN (SELECT team_id FROM memberships
                          WHERE user_id = app_user_id() AND role IN ('admin', 'responder')));

CREATE POLICY rw_writer_insert_events ON incident_events FOR INSERT TO app_rw
  WITH CHECK (
    actor_user_id = app_user_id()
    AND kind IN ('status_changed', 'note')
    AND team_id IN (SELECT team_id FROM memberships
                    WHERE user_id = app_user_id() AND role IN ('admin', 'responder'))
  );

-- Tighten audit inserts: the row must name the acting user.
DROP POLICY audit_log_insert ON audit_log;
CREATE POLICY rw_audit_insert_as_self ON audit_log FOR INSERT TO app_rw
  WITH CHECK (actor_user_id = app_user_id());
