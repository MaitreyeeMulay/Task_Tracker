-- 0005: response checklists as living documents (owner request 2026-11-06).
-- Internally the table stays "runbooks": renaming it would break the previous
-- code version, which CLAUDE.md forbids. The UI calls them "response checklists".
--
-- Additive:
--   checklist_steps            steps as rows with stable ids, status and provenance
--   checklist_step_completions completions keyed by step id, with an optional finding
--   incidents.resolution_note  "what fixed it", written when resolving
-- The old runbook_step_completions table is kept (previous code reads it) and
-- its rows are copied across. runbooks.body_md is left as it was.

-- Writer = admin or responder of the team. Runs with the caller's rights, so
-- the memberships policy (own rows only) applies; no recursion, no definer.
CREATE FUNCTION app_is_writer(team uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM memberships
                 WHERE team_id = team AND user_id = app_user_id() AND role IN ('admin', 'responder'))
$$;

CREATE FUNCTION app_is_member(team uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM memberships WHERE team_id = team AND user_id = app_user_id())
$$;

-- Same step syntax as src/runbooks/markdown.ts: "- [ ] text" or "* [x] text".
CREATE FUNCTION checklist_steps_from_markdown(body text) RETURNS TABLE (pos integer, text text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT (row_number() OVER (ORDER BY l.n))::integer, trim(m[1])
  FROM regexp_split_to_table(replace(body, E'\r\n', E'\n'), E'\n') WITH ORDINALITY AS l(line, n)
  CROSS JOIN LATERAL regexp_match(trim(l.line), '^[-*]\s+\[[ xX]\]\s*(.*\S)\s*$') AS m
  WHERE m IS NOT NULL
  ORDER BY l.n
  LIMIT 100
$$;

CREATE TABLE checklist_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runbook_id uuid NOT NULL,
  team_id uuid NOT NULL,
  sort_order integer NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'rejected', 'retired')),
  source_incident_id uuid,
  added_by uuid REFERENCES users (id),
  added_by_name text CHECK (length(added_by_name) BETWEEN 1 AND 200),
  reviewed_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  retired_at timestamptz,
  FOREIGN KEY (runbook_id, team_id) REFERENCES runbooks (id, team_id),
  FOREIGN KEY (source_incident_id, team_id) REFERENCES incidents (id, team_id),
  UNIQUE (id, team_id)
);
CREATE INDEX checklist_steps_runbook_idx ON checklist_steps (runbook_id, status, sort_order);

CREATE TABLE checklist_step_completions (
  run_id uuid NOT NULL,
  team_id uuid NOT NULL,
  step_id uuid NOT NULL,
  finding text CHECK (length(finding) BETWEEN 1 AND 2000),
  completed_by uuid NOT NULL REFERENCES users (id),
  completed_by_name text NOT NULL CHECK (length(completed_by_name) BETWEEN 1 AND 200),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id, team_id) REFERENCES runbook_runs (id, team_id),
  FOREIGN KEY (step_id, team_id) REFERENCES checklist_steps (id, team_id)
);
CREATE TRIGGER checklist_step_completions_no_update_delete
  BEFORE UPDATE OR DELETE ON checklist_step_completions
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER checklist_step_completions_no_truncate
  BEFORE TRUNCATE ON checklist_step_completions
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

ALTER TABLE incidents ADD COLUMN resolution_note text CHECK (length(resolution_note) BETWEEN 1 AND 2000);

-- Backfill existing data.
INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text)
SELECT r.id, r.team_id, s.pos, s.text
FROM runbooks r CROSS JOIN LATERAL checklist_steps_from_markdown(r.body_md) s;

INSERT INTO checklist_step_completions (run_id, team_id, step_id, completed_by, completed_by_name, completed_at)
SELECT c.run_id, c.team_id, s.id, c.completed_by, c.completed_by_name, c.completed_at
FROM runbook_step_completions c
JOIN runbook_runs rr ON rr.id = c.run_id
JOIN checklist_steps s ON s.runbook_id = rr.runbook_id AND s.sort_order = c.step_index + 1;

-- Row-level security.
ALTER TABLE checklist_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE checklist_step_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_step_completions FORCE ROW LEVEL SECURITY;

GRANT INSERT, UPDATE (title, body_md) ON runbooks TO app_rw;
GRANT SELECT, INSERT, UPDATE (status, reviewed_by, reviewed_at, retired_at) ON checklist_steps TO app_rw;
GRANT SELECT, INSERT ON checklist_step_completions TO app_rw;

CREATE POLICY rw_writer_create_runbooks ON runbooks FOR INSERT TO app_rw WITH CHECK (app_is_writer(team_id));
CREATE POLICY rw_writer_edit_runbooks ON runbooks FOR UPDATE TO app_rw
  USING (app_is_writer(team_id)) WITH CHECK (app_is_writer(team_id));

CREATE POLICY rw_member_steps ON checklist_steps FOR SELECT TO app_rw USING (app_is_member(team_id));
CREATE POLICY rw_writer_add_steps ON checklist_steps FOR INSERT TO app_rw
  WITH CHECK (app_is_writer(team_id) AND added_by = app_user_id() AND status IN ('active', 'proposed'));
CREATE POLICY rw_writer_review_steps ON checklist_steps FOR UPDATE TO app_rw
  USING (app_is_writer(team_id)) WITH CHECK (app_is_writer(team_id));

CREATE POLICY rw_member_step_completions ON checklist_step_completions FOR SELECT TO app_rw USING (app_is_member(team_id));
CREATE POLICY rw_writer_complete_checklist_steps ON checklist_step_completions FOR INSERT TO app_rw
  WITH CHECK (app_is_writer(team_id) AND completed_by = app_user_id());
