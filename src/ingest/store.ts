import type { ClientBase } from "pg";
import type { NormalizedAlert } from "./cloudwatch.ts";

// Database side of ingestion. Callers run these inside a transaction as the
// app_ingest role (see withIngestRole), so RLS and grants limit what they can do.

export interface SnsIntegration {
  id: string;
  serviceId: string;
  teamId: string;
  topicArn: string;
}

export type IngestOutcome =
  | { kind: "duplicate_delivery" }
  | { kind: "incident_opened"; incidentId: string }
  | { kind: "incident_updated"; incidentId: string; alertCount: number }
  | { kind: "alert_cleared"; incidentId: string }
  | { kind: "cleared_without_incident" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Active SNS integrations only (the ingest policy hides inactive ones). */
export async function findSnsIntegration(db: ClientBase, id: string): Promise<SnsIntegration | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<SnsIntegration>(
    `SELECT i.id, i.service_id AS "serviceId", s.team_id AS "teamId", i.sns_topic_arn AS "topicArn"
     FROM integrations i JOIN services s ON s.id = i.service_id
     WHERE i.id = $1 AND i.kind = 'sns'`,
    [id],
  );
  return rows[0] ?? null;
}

export async function ingestAlert(
  db: ClientBase,
  integration: SnsIntegration,
  alert: NormalizedAlert,
  payload: unknown,
): Promise<IngestOutcome> {
  // 1. Store the raw alert once per delivery; a retry of the same message stops here.
  const stored = await db.query<{ id: string }>(
    `INSERT INTO alerts (integration_id, external_id, fingerprint, status, severity, title, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (integration_id, external_id) DO NOTHING
     RETURNING id`,
    [integration.id, alert.externalId, alert.fingerprint, alert.status, alert.severity, alert.title, JSON.stringify(payload)],
  );
  const alertId = stored.rows[0]?.id;
  if (!alertId) return { kind: "duplicate_delivery" };

  if (alert.status === "resolved") return recordCleared(db, integration, alert, alertId);

  // 2. Open an incident, or bump the open one. The partial unique index makes this
  //    race-free: concurrent duplicates all land on the same row.
  const { rows } = await db.query<{ id: string; alert_count: number; created: boolean }>(
    `INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (service_id, fingerprint) WHERE status <> 'resolved'
     DO UPDATE SET alert_count = incidents.alert_count + 1, last_alert_at = now()
     RETURNING id, alert_count, (xmax = 0) AS created`,
    [integration.serviceId, integration.teamId, alert.fingerprint, alert.severity, alert.title],
  );
  const incident = rows[0];
  if (!incident) throw new Error("incident upsert returned no row");

  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, alert_id) VALUES ($1, $2, 'alert_received', $3)`,
    [incident.id, integration.teamId, alertId],
  );

  if (!incident.created) return { kind: "incident_updated", incidentId: incident.id, alertCount: incident.alert_count };

  await db.query(
    `INSERT INTO audit_log (team_id, action, entity_type, entity_id) VALUES ($1, 'incident.opened', 'incident', $2)`,
    [integration.teamId, incident.id],
  );
  return { kind: "incident_opened", incidentId: incident.id };
}

// A cleared alarm is recorded on the open incident; resolving stays a human decision.
async function recordCleared(db: ClientBase, integration: SnsIntegration, alert: NormalizedAlert, alertId: string): Promise<IngestOutcome> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM incidents WHERE service_id = $1 AND fingerprint = $2 AND status <> 'resolved'`,
    [integration.serviceId, alert.fingerprint],
  );
  const incidentId = rows[0]?.id;
  if (!incidentId) return { kind: "cleared_without_incident" };

  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, alert_id) VALUES ($1, $2, 'alert_resolved', $3)`,
    [incidentId, integration.teamId, alertId],
  );
  return { kind: "alert_cleared", incidentId };
}

/** Runs fn in a transaction as app_ingest. Rolls back on any error; never retries. */
export async function withIngestRole<T>(db: ClientBase, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE app_ingest");
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
