-- 0008: M4 — SLA targets, durable timers, notification outbox, worker role.
-- Additive. Timers are created and cancelled by a trigger on incidents, so no
-- code path (ingestion, status change, reopen) can forget them. The trigger runs
-- with the caller's rights; each role gets only the timer rights it needs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO app_worker;

-- SLA targets per severity (SPEC: set per severity). Defaults; change with SQL.
CREATE TABLE sla_targets (
  severity text PRIMARY KEY CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  ack_minutes integer NOT NULL CHECK (ack_minutes > 0),
  resolve_minutes integer NOT NULL CHECK (resolve_minutes > 0)
);
INSERT INTO sla_targets VALUES ('SEV1', 5, 60), ('SEV2', 15, 240), ('SEV3', 60, 1440), ('SEV4', 240, 4320);

-- Wake-at times stored in the database: they survive restarts (SPEC behaviour 3).
CREATE TABLE timers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL,
  team_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('notify_open', 'ack_due', 'resolve_due')),
  wake_at timestamptz NOT NULL,
  fired_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, team_id) REFERENCES incidents (id, team_id)
);
-- At most one live timer of each kind per incident.
CREATE UNIQUE INDEX timers_one_live_per_kind ON timers (incident_id, kind) WHERE fired_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX timers_due_idx ON timers (wake_at) WHERE fired_at IS NULL AND cancelled_at IS NULL;

-- Outbox: one row per recipient per event; the unique key makes "send twice" impossible to create.
CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL,
  team_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('incident_opened', 'ack_overdue', 'resolve_overdue')),
  level integer NOT NULL DEFAULT 1 CHECK (level IN (1, 2)),
  recipient_user_id uuid NOT NULL REFERENCES users (id),
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'dismissed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  sent_at timestamptz,
  provider_message_id text,
  last_error_code text CHECK (length(last_error_code) <= 100),
  reviewed_by uuid REFERENCES users (id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, team_id) REFERENCES incidents (id, team_id),
  UNIQUE (incident_id, kind, level, recipient_user_id)
);
CREATE INDEX notifications_pending_idx ON notifications (next_attempt_at) WHERE status = 'pending';
CREATE INDEX notifications_sending_idx ON notifications (claimed_at) WHERE status = 'sending';

-- Liveness for the "worker silent" alert (M6).
CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (length(worker_id) BETWEEN 1 AND 100),
  seen_at timestamptz NOT NULL
);

-- New timeline kinds written by the worker.
ALTER TABLE incident_events DROP CONSTRAINT incident_events_kind_check;
ALTER TABLE incident_events ADD CONSTRAINT incident_events_kind_check
  CHECK (kind IN ('alert_received', 'alert_resolved', 'status_changed', 'note', 'runbook_step', 'escalated', 'sla_breached'));

-- Timer maintenance, driven by incident inserts and status changes.
CREATE FUNCTION incident_timers() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target sla_targets%ROWTYPE;
BEGIN
  SELECT * INTO target FROM sla_targets WHERE severity = NEW.severity;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO timers (incident_id, team_id, kind, wake_at) VALUES
      (NEW.id, NEW.team_id, 'notify_open', NEW.opened_at),
      (NEW.id, NEW.team_id, 'ack_due', NEW.opened_at + make_interval(mins => target.ack_minutes)),
      (NEW.id, NEW.team_id, 'resolve_due', NEW.opened_at + make_interval(mins => target.resolve_minutes));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status <> 'triggered' THEN
      UPDATE timers SET cancelled_at = now()
      WHERE incident_id = NEW.id AND kind = 'ack_due' AND fired_at IS NULL AND cancelled_at IS NULL;
    END IF;
    IF NEW.status = 'resolved' THEN
      UPDATE timers SET cancelled_at = now()
      WHERE incident_id = NEW.id AND kind = 'resolve_due' AND fired_at IS NULL AND cancelled_at IS NULL;
    ELSIF OLD.status = 'resolved' THEN
      -- Reopened: a fresh resolve target from now.
      INSERT INTO timers (incident_id, team_id, kind, wake_at)
      VALUES (NEW.id, NEW.team_id, 'resolve_due', now() + make_interval(mins => target.resolve_minutes));
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER incidents_maintain_timers
  AFTER INSERT OR UPDATE OF status ON incidents
  FOR EACH ROW EXECUTE FUNCTION incident_timers();

-- Backfill for incidents that already exist (no "opened" emails for old ones).
INSERT INTO timers (incident_id, team_id, kind, wake_at)
SELECT i.id, i.team_id, 'ack_due', i.opened_at + make_interval(mins => t.ack_minutes)
FROM incidents i JOIN sla_targets t ON t.severity = i.severity WHERE i.status = 'triggered';
INSERT INTO timers (incident_id, team_id, kind, wake_at)
SELECT i.id, i.team_id, 'resolve_due', i.opened_at + make_interval(mins => t.resolve_minutes)
FROM incidents i JOIN sla_targets t ON t.severity = i.severity WHERE i.status <> 'resolved';

-- Row-level security: enabled and forced on every new table.
ALTER TABLE sla_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE timers FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app_is_admin(team uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM memberships WHERE team_id = team AND user_id = app_user_id() AND role = 'admin')
$$;

-- SLA targets: readable by every app role (the trigger and the UI need them).
GRANT SELECT ON sla_targets TO app_rw, app_ingest, app_worker;
CREATE POLICY read_sla ON sla_targets FOR SELECT TO app_rw, app_ingest, app_worker USING (true);

-- Timers: ingestion creates them (via the trigger); users see their team's and
-- the trigger cancels/creates them on status changes; the worker fires them.
GRANT SELECT, INSERT ON timers TO app_ingest;
CREATE POLICY ingest_create_timers ON timers FOR INSERT TO app_ingest WITH CHECK (true);
CREATE POLICY ingest_read_timers ON timers FOR SELECT TO app_ingest USING (true);
GRANT SELECT, INSERT, UPDATE (cancelled_at) ON timers TO app_rw;
CREATE POLICY rw_member_timers ON timers FOR SELECT TO app_rw USING (app_is_member(team_id));
CREATE POLICY rw_writer_create_timers ON timers FOR INSERT TO app_rw WITH CHECK (app_is_writer(team_id));
CREATE POLICY rw_writer_cancel_timers ON timers FOR UPDATE TO app_rw USING (app_is_writer(team_id)) WITH CHECK (app_is_writer(team_id));
GRANT SELECT, UPDATE (fired_at, cancelled_at) ON timers TO app_worker;
CREATE POLICY worker_timers ON timers FOR ALL TO app_worker USING (true) WITH CHECK (true);

-- Notifications: the worker owns the outbox; team admins can see theirs and
-- decide what happens to messages that need a person (needs_review / failed).
GRANT SELECT, INSERT, UPDATE ON notifications TO app_worker;
CREATE POLICY worker_notifications ON notifications FOR ALL TO app_worker USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (status, next_attempt_at, reviewed_by, reviewed_at) ON notifications TO app_rw;
CREATE POLICY rw_admin_read_notifications ON notifications FOR SELECT TO app_rw USING (app_is_admin(team_id));
CREATE POLICY rw_admin_review_notifications ON notifications FOR UPDATE TO app_rw
  USING (app_is_admin(team_id) AND status IN ('needs_review', 'failed'))
  WITH CHECK (app_is_admin(team_id) AND status IN ('pending', 'sent', 'dismissed') AND reviewed_by = app_user_id());

GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO app_worker;
CREATE POLICY worker_heartbeat ON worker_heartbeats FOR ALL TO app_worker USING (true) WITH CHECK (true);

-- The worker reads what it needs to address and describe messages.
GRANT SELECT ON incidents, services, memberships, users TO app_worker;
CREATE POLICY worker_read_incidents ON incidents FOR SELECT TO app_worker USING (true);
CREATE POLICY worker_read_services ON services FOR SELECT TO app_worker USING (true);
CREATE POLICY worker_read_memberships ON memberships FOR SELECT TO app_worker USING (true);
CREATE POLICY worker_read_users ON users FOR SELECT TO app_worker USING (true);

GRANT INSERT ON incident_events TO app_worker;
CREATE POLICY worker_timeline ON incident_events FOR INSERT TO app_worker
  WITH CHECK (actor_user_id IS NULL AND kind IN ('escalated', 'sla_breached'));
