-- 0002: services, integrations, alerts, incidents, incident timeline.
-- Additive only. RLS enabled and forced on every table.
--   app_rw     (users, M2): grants now, team policies added in M2, so it reads nothing yet.
--   app_ingest (webhook path): narrow system role, explained below.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ingest') THEN
    CREATE ROLE app_ingest NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO app_ingest;

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name),
  UNIQUE (id, team_id) -- lets incidents prove their team owns the service
);

-- Signing secrets are never stored here: webhook integrations hold a reference
-- (an AWS Secrets Manager name/ARN); SNS integrations are pinned to a topic ARN.
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services (id),
  kind text NOT NULL CHECK (kind IN ('sns', 'webhook')),
  sns_topic_arn text CHECK (length(sns_topic_arn) <= 512 AND sns_topic_arn ~ '^arn:aws[a-z-]*:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$'),
  secret_ref text CHECK (length(secret_ref) BETWEEN 1 AND 2048),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'sns' OR sns_topic_arn IS NOT NULL),
  CHECK (kind <> 'webhook' OR secret_ref IS NOT NULL)
);
CREATE INDEX integrations_service_id_idx ON integrations (service_id);

-- Raw alerts as received. (integration_id, external_id) makes re-deliveries no-ops.
CREATE TABLE alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_id uuid NOT NULL REFERENCES integrations (id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('firing', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_id)
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL,
  team_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'triggered'
    CHECK (status IN ('triggered', 'acknowledged', 'mitigated', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  alert_count integer NOT NULL DEFAULT 1 CHECK (alert_count >= 1),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_alert_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  mitigated_at timestamptz,
  resolved_at timestamptz,
  FOREIGN KEY (service_id, team_id) REFERENCES services (id, team_id),
  UNIQUE (id, team_id)
);
-- The dedupe rule (SPEC behaviour 1): one open incident per service and fingerprint.
CREATE UNIQUE INDEX incidents_one_open_per_fingerprint
  ON incidents (service_id, fingerprint) WHERE status <> 'resolved';
CREATE INDEX incidents_team_status_idx ON incidents (team_id, status, opened_at DESC);

-- Timeline. team_id is repeated so RLS can scope it without a join.
CREATE TABLE incident_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL,
  team_id uuid NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('alert_received', 'alert_resolved', 'status_changed', 'note', 'runbook_step')),
  alert_id bigint REFERENCES alerts (id),
  actor_user_id uuid REFERENCES users (id),
  data jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, team_id) REFERENCES incidents (id, team_id)
);
CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, occurred_at);

CREATE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER incident_events_no_update_delete
  BEFORE UPDATE OR DELETE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER incident_events_no_truncate
  BEFORE TRUNCATE ON incident_events
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_events FORCE ROW LEVEL SECURITY;

-- app_rw: privileges only. Without policies, RLS returns no rows (closed by default).
GRANT SELECT ON services, integrations, alerts, incidents, incident_events TO app_rw;
GRANT INSERT, UPDATE ON services, integrations, incidents TO app_rw;
GRANT INSERT ON incident_events TO app_rw;

-- app_ingest: the webhook path acts for no user, so it gets the smallest set
-- of rights that ingestion needs, and nothing that reads people or the audit log.
GRANT SELECT ON services, integrations TO app_ingest;
GRANT SELECT, INSERT ON alerts TO app_ingest;
GRANT SELECT, INSERT ON incidents TO app_ingest;
GRANT UPDATE (alert_count, last_alert_at) ON incidents TO app_ingest;
GRANT INSERT ON incident_events, audit_log TO app_ingest;

CREATE POLICY ingest_read_services ON services FOR SELECT TO app_ingest USING (true);
CREATE POLICY ingest_read_integrations ON integrations FOR SELECT TO app_ingest USING (active);
CREATE POLICY ingest_read_alerts ON alerts FOR SELECT TO app_ingest USING (true);
CREATE POLICY ingest_insert_alerts ON alerts FOR INSERT TO app_ingest WITH CHECK (true);
CREATE POLICY ingest_read_open_incidents ON incidents FOR SELECT TO app_ingest USING (status <> 'resolved');
CREATE POLICY ingest_insert_incidents ON incidents FOR INSERT TO app_ingest WITH CHECK (status = 'triggered');
CREATE POLICY ingest_bump_open_incidents ON incidents FOR UPDATE TO app_ingest
  USING (status <> 'resolved') WITH CHECK (status <> 'resolved');
CREATE POLICY ingest_insert_events ON incident_events FOR INSERT TO app_ingest
  WITH CHECK (actor_user_id IS NULL AND kind IN ('alert_received', 'alert_resolved'));
CREATE POLICY ingest_insert_audit ON audit_log FOR INSERT TO app_ingest WITH CHECK (actor_user_id IS NULL);
