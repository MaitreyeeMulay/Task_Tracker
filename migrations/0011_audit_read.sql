-- 0011: M5 audit log view and export. Team admins may read their own teams'
-- audit entries. Still append-only: no UPDATE/DELETE grants, and the 0001
-- triggers block them for everyone.

GRANT SELECT ON audit_log TO app_rw;
CREATE POLICY rw_admin_read_audit ON audit_log FOR SELECT TO app_rw USING (app_is_admin(team_id));
