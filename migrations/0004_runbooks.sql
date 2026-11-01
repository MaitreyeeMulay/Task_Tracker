-- 0004: runbooks, runbook runs on incidents, step completions (M3).
-- Additive: new tables, and the timeline insert policy also allows 'runbook_step'.

CREATE TABLE runbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  service_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body_md text NOT NULL CHECK (length(body_md) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (service_id, team_id) REFERENCES services (id, team_id),
  UNIQUE (id, team_id)
);
CREATE INDEX runbooks_service_idx ON runbooks (service_id);

-- One run per runbook per incident, started by the first completed step.
CREATE TABLE runbook_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runbook_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  team_id uuid NOT NULL,
  started_by uuid NOT NULL REFERENCES users (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (runbook_id, team_id) REFERENCES runbooks (id, team_id),
  FOREIGN KEY (incident_id, team_id) REFERENCES incidents (id, team_id),
  UNIQUE (incident_id, runbook_id),
  UNIQUE (id, team_id)
);

-- The primary key makes "complete the same step twice" impossible.
CREATE TABLE runbook_step_completions (
  run_id uuid NOT NULL,
  team_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 99),
  step_text text NOT NULL CHECK (length(step_text) BETWEEN 1 AND 1000),
  completed_by uuid NOT NULL REFERENCES users (id),
  completed_by_name text NOT NULL CHECK (length(completed_by_name) BETWEEN 1 AND 200),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_index),
  FOREIGN KEY (run_id, team_id) REFERENCES runbook_runs (id, team_id)
);

CREATE TRIGGER runbook_step_completions_no_update_delete
  BEFORE UPDATE OR DELETE ON runbook_step_completions
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER runbook_step_completions_no_truncate
  BEFORE TRUNCATE ON runbook_step_completions
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

ALTER TABLE runbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE runbooks FORCE ROW LEVEL SECURITY;
ALTER TABLE runbook_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runbook_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE runbook_step_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runbook_step_completions FORCE ROW LEVEL SECURITY;

GRANT SELECT ON runbooks TO app_rw;
GRANT SELECT, INSERT ON runbook_runs, runbook_step_completions TO app_rw;

CREATE POLICY rw_member_runbooks ON runbooks FOR SELECT TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));
CREATE POLICY rw_member_runs ON runbook_runs FOR SELECT TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));
CREATE POLICY rw_member_completions ON runbook_step_completions FOR SELECT TO app_rw
  USING (team_id IN (SELECT team_id FROM memberships WHERE user_id = app_user_id()));

CREATE POLICY rw_writer_start_runs ON runbook_runs FOR INSERT TO app_rw
  WITH CHECK (
    started_by = app_user_id()
    AND team_id IN (SELECT team_id FROM memberships
                    WHERE user_id = app_user_id() AND role IN ('admin', 'responder'))
  );
CREATE POLICY rw_writer_complete_steps ON runbook_step_completions FOR INSERT TO app_rw
  WITH CHECK (
    completed_by = app_user_id()
    AND team_id IN (SELECT team_id FROM memberships
                    WHERE user_id = app_user_id() AND role IN ('admin', 'responder'))
  );

-- Allow runbook steps on the timeline (same writer rule as before).
ALTER POLICY rw_writer_insert_events ON incident_events
  WITH CHECK (
    actor_user_id = app_user_id()
    AND kind IN ('status_changed', 'note', 'runbook_step')
    AND team_id IN (SELECT team_id FROM memberships
                    WHERE user_id = app_user_id() AND role IN ('admin', 'responder'))
  );
