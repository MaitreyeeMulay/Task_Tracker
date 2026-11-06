import type { ClientBase } from "pg";
import { parseCaseNumber } from "./case-number.ts";
import { planReopen, planTransition, type IncidentStatus } from "./status.ts";

// Incident reads and writes for signed-in users. Callers run these as app_rw
// with the user set (src/db/with-user.ts): RLS limits every query to the user's
// teams, and to admins/responders for writes. Nothing here re-implements that.

export interface IncidentSummary {
  id: string;
  /** INC-1001 style, unique and permanent. */
  caseNumber: string;
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
  /** "What fixed it", recorded when resolving. */
  resolutionNote: string | null;
  /** checklist_step, other_fix or self_resolved (null if resolved before 0006, or not resolved). */
  resolutionKind: string | null;
  timeline: TimelineEntry[];
}

export type ChangeResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUMMARY_COLUMNS = `
  i.id, 'INC-' || i.number AS "caseNumber", i.title, i.severity, i.status, s.name AS service,
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
  if (kind === "status_changed" && typeof data.from === "string" && typeof data.to === "string") {
    const reason = typeof data.reason === "string" ? ` (reopened: ${data.reason})` : "";
    return `${data.from} → ${data.to}${reason}`;
  }
  if (kind === "alert_resolved") return "alarm cleared";
  if (kind === "runbook_step" && typeof data.runbook_title === "string" && typeof data.step_text === "string") {
    const finding = typeof data.finding === "string" ? ` — ${data.finding}` : "";
    return `${data.runbook_title}: ✓ ${data.step_text}${finding}`;
  }
  if ((kind === "note" || kind === "escalated" || kind === "sla_breached") && typeof data.text === "string") return data.text;
  return null;
}

export async function getIncident(db: ClientBase, id: string): Promise<IncidentDetail | null> {
  // Accepts the incident id or its case number (INC-1001). RLS still limits it to the user's teams.
  const caseNumber = parseCaseNumber(id);
  if (!caseNumber && !UUID.test(id)) return null;
  const { rows } = await db.query<IncidentSummary & { canWrite: boolean; resolutionNote: string | null; resolutionKind: string | null }>(
    `SELECT ${SUMMARY_COLUMNS}, i.resolution_note AS "resolutionNote", i.resolution_kind AS "resolutionKind",
       EXISTS (SELECT 1 FROM memberships m
               WHERE m.team_id = i.team_id AND m.user_id = app_user_id()
                 AND m.role IN ('admin', 'responder')) AS "canWrite"
     FROM incidents i JOIN services s ON s.id = i.service_id
     WHERE ${caseNumber ? "i.number = $1" : "i.id = $1"}`,
    [caseNumber ?? id],
  );
  const incident = rows[0];
  if (!incident) return null;

  const events = await db.query<{ kind: string; occurredAt: Date; data: Record<string, unknown> }>(
    `SELECT kind, occurred_at AS "occurredAt", data FROM incident_events
     WHERE incident_id = $1 ORDER BY occurred_at, id`,
    [incident.id],
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
  {
    incidentId,
    to,
    actor,
    now,
    resolutionNote,
  }: { incidentId: string; to: string; actor: { id: string; name: string }; now: Date; resolutionNote?: string },
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

  // "What fixed it": kept on the incident and shown on the timeline, so it can
  // later be proposed as a checklist step (src/runbooks/repo.ts proposeStep).
  const note = resolutionNote?.trim().slice(0, 2000);
  if (plan.status === "resolved" && note) {
    await db.query("UPDATE incidents SET resolution_note = $2 WHERE id = $1", [incidentId, note]);
    await db.query(
      `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data) VALUES ($1, $2, 'note', $3, $4)`,
      [incidentId, teamId, actor.id, JSON.stringify({ text: `What fixed it: ${note}`, actor_name: actor.name })],
    );
  }
  return { ok: true };
}

/**
 * Reopens a resolved incident (owner request 2026-11-07). A reason is required.
 * The previous resolution is cleared from the incident (so a checklist step that
 * "fixed" it stops counting) but kept on the timeline. Refused when a newer open
 * incident exists for the same alarm, since only one may be open per fingerprint.
 */
export async function reopenIncident(
  db: ClientBase,
  { incidentId, reason, actor, now }: { incidentId: string; reason: string; actor: { id: string; name: string }; now: Date },
): Promise<{ ok: true } | { ok: false; error: string; openCase?: string }> {
  const why = reason.trim();
  if (why.length < 1 || why.length > 1000) return { ok: false, error: "invalid_text" };
  const incident = await getIncident(db, incidentId);
  if (!incident) return { ok: false, error: "not_found" };
  if (!incident.canWrite) return { ok: false, error: "forbidden" };
  const plan = planReopen(incident.status, now);
  if (!plan.ok) return plan;

  const { rows } = await db.query<{ team_id: string; service_id: string; fingerprint: string }>(
    "SELECT team_id, service_id, fingerprint FROM incidents WHERE id = $1",
    [incident.id],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };

  // A savepoint lets us recover from the unique-index violation and explain it.
  await db.query("SAVEPOINT reopen");
  try {
    const updated = await db.query(
      `UPDATE incidents SET status = $2, acknowledged_at = $3, mitigated_at = NULL, resolved_at = NULL,
         resolution_kind = NULL, resolution_step_id = NULL, resolution_note = NULL
       WHERE id = $1 AND status = 'resolved'`,
      [incident.id, plan.status, now],
    );
    await db.query("RELEASE SAVEPOINT reopen");
    if (updated.rowCount !== 1) return { ok: false, error: "conflict" };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    await db.query("ROLLBACK TO SAVEPOINT reopen");
    const open = await db.query<{ case: string }>(
      `SELECT 'INC-' || number AS case FROM incidents
       WHERE service_id = $1 AND fingerprint = $2 AND status <> 'resolved'`,
      [row.service_id, row.fingerprint],
    );
    return { ok: false, error: "duplicate_open", ...(open.rows[0] ? { openCase: open.rows[0].case } : {}) };
  }

  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data) VALUES ($1, $2, 'status_changed', $3, $4)`,
    [
      incident.id,
      row.team_id,
      actor.id,
      JSON.stringify({
        from: "resolved",
        to: plan.status,
        reason: why,
        previous_resolution: { kind: incident.resolutionKind, note: incident.resolutionNote },
        actor_name: actor.name,
      }),
    ],
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'incident.reopened', 'incident', $3)`,
    [actor.id, row.team_id, incident.id],
  );
  return { ok: true };
}
