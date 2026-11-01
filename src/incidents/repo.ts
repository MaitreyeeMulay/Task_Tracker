import type { ClientBase } from "pg";
import { planTransition, type IncidentStatus } from "./status.ts";

// Incident reads and writes for signed-in users. Callers run these as app_rw
// with the user set (src/db/with-user.ts): RLS limits every query to the user's
// teams, and to admins/responders for writes. Nothing here re-implements that.

export interface IncidentSummary {
  id: string;
  title: string;
  severity: string;
  status: IncidentStatus;
  service: string;
  alertCount: number;
  openedAt: Date;
}

export interface TimelineEntry {
  kind: string;
  occurredAt: Date;
  actorName: string | null;
  detail: string | null;
}

export interface IncidentDetail extends IncidentSummary {
  canWrite: boolean;
  timeline: TimelineEntry[];
}

export type ChangeResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUMMARY_COLUMNS = `
  i.id, i.title, i.severity, i.status, s.name AS service,
  i.alert_count AS "alertCount", i.opened_at AS "openedAt"`;

/** Open incidents first (most severe, newest), then resolved ones. */
export async function listIncidents(db: ClientBase): Promise<IncidentSummary[]> {
  const { rows } = await db.query<IncidentSummary>(
    `SELECT ${SUMMARY_COLUMNS}
     FROM incidents i JOIN services s ON s.id = i.service_id
     ORDER BY (i.status = 'resolved'), i.severity, i.opened_at DESC
     LIMIT 200`,
  );
  return rows;
}

function describe(kind: string, data: Record<string, unknown>): string | null {
  if (kind === "status_changed" && typeof data.from === "string" && typeof data.to === "string") return `${data.from} → ${data.to}`;
  if (kind === "alert_resolved") return "alarm cleared";
  return null;
}

export async function getIncident(db: ClientBase, id: string): Promise<IncidentDetail | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<IncidentSummary & { canWrite: boolean }>(
    `SELECT ${SUMMARY_COLUMNS},
       EXISTS (SELECT 1 FROM memberships m
               WHERE m.team_id = i.team_id AND m.user_id = app_user_id()
                 AND m.role IN ('admin', 'responder')) AS "canWrite"
     FROM incidents i JOIN services s ON s.id = i.service_id
     WHERE i.id = $1`,
    [id],
  );
  const incident = rows[0];
  if (!incident) return null;

  const events = await db.query<{ kind: string; occurredAt: Date; data: Record<string, unknown> }>(
    `SELECT kind, occurred_at AS "occurredAt", data FROM incident_events
     WHERE incident_id = $1 ORDER BY occurred_at, id`,
    [id],
  );
  const timeline = events.rows.map((e) => ({
    kind: e.kind,
    occurredAt: e.occurredAt,
    actorName: typeof e.data.actor_name === "string" ? e.data.actor_name : null,
    detail: describe(e.kind, e.data),
  }));
  return { ...incident, timeline };
}

export async function changeStatus(
  db: ClientBase,
  { incidentId, to, actor, now }: { incidentId: string; to: string; actor: { id: string; name: string }; now: Date },
): Promise<ChangeResult> {
  const incident = await getIncident(db, incidentId);
  if (!incident) return { ok: false, error: "not_found" };
  if (!incident.canWrite) return { ok: false, error: "forbidden" };

  const plan = planTransition(incident.status, to, now);
  if (!plan.ok) return plan;

  // Column names come from the fixed set in status.ts, never from input.
  const [column, value] = Object.entries(plan.set)[0] ?? [];
  const updated = await db.query(
    `UPDATE incidents SET status = $2${column ? `, ${column} = $4` : ""} WHERE id = $1 AND status = $3`,
    column ? [incidentId, plan.status, incident.status, value] : [incidentId, plan.status, incident.status],
  );
  // 0 rows: someone changed it first (or RLS refused). Never retried automatically.
  if (updated.rowCount !== 1) return { ok: false, error: "conflict" };

  const teamId = (await db.query<{ team_id: string }>("SELECT team_id FROM incidents WHERE id = $1", [incidentId])).rows[0]?.team_id;
  // The actor's display name is stored on the event: teammates cannot read each other's user rows.
  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data)
     VALUES ($1, $2, 'status_changed', $3, $4)`,
    [incidentId, teamId, actor.id, JSON.stringify({ from: incident.status, to: plan.status, actor_name: actor.name })],
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'incident.status_changed', 'incident', $3)`,
    [actor.id, teamId, incidentId],
  );
  return { ok: true };
}
