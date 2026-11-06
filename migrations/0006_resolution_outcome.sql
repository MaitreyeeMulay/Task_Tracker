-- 0006: how an incident was resolved (owner request 2026-11-06).
-- Additive: two nullable columns; previous code ignores them.
--   checklist_step  a completed checklist step fixed it (resolution_step_id)
--   other_fix       something else fixed it (resolution_note; may be proposed as a step)
--   self_resolved   recovered on its own / false alarm (optional note)

ALTER TABLE incidents ADD COLUMN resolution_kind text
  CHECK (resolution_kind IN ('checklist_step', 'other_fix', 'self_resolved'));
ALTER TABLE incidents ADD COLUMN resolution_step_id uuid;
ALTER TABLE incidents ADD CONSTRAINT incidents_resolution_step_fk
  FOREIGN KEY (resolution_step_id, team_id) REFERENCES checklist_steps (id, team_id);
ALTER TABLE incidents ADD CONSTRAINT incidents_resolution_step_kind
  CHECK (resolution_step_id IS NULL OR resolution_kind = 'checklist_step');

CREATE INDEX incidents_resolution_step_idx ON incidents (resolution_step_id) WHERE resolution_step_id IS NOT NULL;
