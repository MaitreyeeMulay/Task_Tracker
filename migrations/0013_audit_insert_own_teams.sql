-- 0013: M7 review. An audit row written by a user may only name one of that
-- user's teams (or no team, as the audit export does). Before this, app_rw
-- could write a row into any team's audit trail as long as it named itself as
-- the actor; the app never did, but the database should refuse it too.
-- Compatible with the previous code: it only ever audits teams the user acts in.
-- Replaced in the migration's transaction, so there is no moment without a policy.

DROP POLICY rw_audit_insert_as_self ON audit_log;
CREATE POLICY rw_audit_insert_as_self ON audit_log FOR INSERT TO app_rw
  WITH CHECK (actor_user_id = app_user_id() AND (team_id IS NULL OR app_is_member(team_id)));
