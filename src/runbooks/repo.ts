import type { ClientBase } from "pg";
import { getIncident } from "../incidents/repo.ts";
import { parseRunbook } from "./markdown.ts";

// Runbooks for signed-in users. As with incidents, callers run these as app_rw
// with the user set; RLS limits rows to the user's teams and writes to
// admins/responders. A runbook only opens from an incident of its own service.

export interface RunbookSummary {
  id: string;
  title: string;
  stepCount: number;
  doneCount: number;
}

export interface RunbookView {
  incident: { id: string; title: string; canWrite: boolean };
  runbook: { id: string; title: string; body: string };
  completed: Record<number, { by: string; at: Date }>;
}

export type StepResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRunbooksForIncident(db: ClientBase, incidentId: string): Promise<RunbookSummary[]> {
  if (!UUID.test(incidentId)) return [];
  const { rows } = await db.query<{ id: string; title: string; body: string; doneCount: number }>(
    `SELECT r.id, r.title, r.body_md AS body,
            (SELECT count(*)::int FROM runbook_runs rr JOIN runbook_step_completions c ON c.run_id = rr.id
             WHERE rr.runbook_id = r.id AND rr.incident_id = i.id) AS "doneCount"
     FROM incidents i JOIN runbooks r ON r.service_id = i.service_id
     WHERE i.id = $1
     ORDER BY r.title`,
    [incidentId],
  );
  return rows.map(({ id, title, body, doneCount }) => ({ id, title, stepCount: parseRunbook(body).steps.length, doneCount }));
}

export async function getRunbookForIncident(db: ClientBase, incidentId: string, runbookId: string): Promise<RunbookView | null> {
  if (!UUID.test(incidentId) || !UUID.test(runbookId)) return null;
  const incident = await getIncident(db, incidentId);
  if (!incident) return null;

  const { rows } = await db.query<{ id: string; title: string; body: string }>(
    `SELECT r.id, r.title, r.body_md AS body
     FROM runbooks r JOIN incidents i ON i.service_id = r.service_id
     WHERE r.id = $1 AND i.id = $2`,
    [runbookId, incidentId],
  );
  const runbook = rows[0];
  if (!runbook) return null;

  const done = await db.query<{ step_index: number; by: string; at: Date }>(
    `SELECT c.step_index, c.completed_by_name AS by, c.completed_at AS at
     FROM runbook_runs rr JOIN runbook_step_completions c ON c.run_id = rr.id
     WHERE rr.runbook_id = $1 AND rr.incident_id = $2`,
    [runbookId, incidentId],
  );
  const completed: RunbookView["completed"] = {};
  for (const row of done.rows) completed[row.step_index] = { by: row.by, at: row.at };

  return { incident: { id: incident.id, title: incident.title, canWrite: incident.canWrite }, runbook, completed };
}

export async function completeStep(
  db: ClientBase,
  { incidentId, runbookId, stepIndex, actor, now }: { incidentId: string; runbookId: string; stepIndex: number; actor: { id: string; name: string }; now: Date },
): Promise<StepResult> {
  const view = await getRunbookForIncident(db, incidentId, runbookId);
  if (!view) return { ok: false, error: "not_found" };
  if (!view.incident.canWrite) return { ok: false, error: "forbidden" };

  const stepText = parseRunbook(view.runbook.body).steps[stepIndex];
  if (!Number.isInteger(stepIndex) || stepText === undefined) return { ok: false, error: "invalid_step" };

  const teamId = (await db.query<{ team_id: string }>("SELECT team_id FROM incidents WHERE id = $1", [incidentId])).rows[0]?.team_id;
  await db.query(
    `INSERT INTO runbook_runs (runbook_id, incident_id, team_id, started_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (incident_id, runbook_id) DO NOTHING`,
    [runbookId, incidentId, teamId, actor.id],
  );
  const runId = (await db.query<{ id: string }>("SELECT id FROM runbook_runs WHERE incident_id = $1 AND runbook_id = $2", [incidentId, runbookId]))
    .rows[0]?.id;

  const inserted = await db.query(
    `INSERT INTO runbook_step_completions (run_id, team_id, step_index, step_text, completed_by, completed_by_name, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, step_index) DO NOTHING`,
    [runId, teamId, stepIndex, stepText, actor.id, actor.name, now],
  );
  if (inserted.rowCount !== 1) return { ok: false, error: "already_done" };

  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data)
     VALUES ($1, $2, 'runbook_step', $3, $4)`,
    [
      incidentId,
      teamId,
      actor.id,
      JSON.stringify({ runbook_id: runbookId, runbook_title: view.runbook.title, step: stepIndex, step_text: stepText, actor_name: actor.name }),
    ],
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'runbook.step_completed', 'incident', $3)`,
    [actor.id, teamId, incidentId],
  );
  return { ok: true };
}
