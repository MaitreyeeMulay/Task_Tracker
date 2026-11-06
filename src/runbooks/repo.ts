import type { ClientBase } from "pg";
import { getIncident } from "../incidents/repo.ts";
import { parseRunbook } from "./markdown.ts";

// Response checklists (stored in the "runbooks" table; see migration 0005).
// A checklist is a Markdown document plus steps kept as rows with stable ids,
// so editing never shifts what an earlier completion points at.
// Callers run these as app_rw with the user set: RLS limits rows to the user's
// teams and every write to the team's admins/responders, acting as themselves.

export type Actor = { id: string; name: string };
export type Result = { ok: true } | { ok: false; error: string };

export interface ChecklistStep {
  id: string;
  text: string;
  sourceIncidentId: string | null;
  sourceIncidentTitle: string | null;
  addedBy: string | null;
  /** How many incidents this step resolved (incidents.resolution_step_id). */
  fixedCount: number;
}

export interface ProposedStep {
  id: string;
  text: string;
  sourceIncidentId: string | null;
  sourceIncidentTitle: string | null;
  by: string | null;
}

export interface ChecklistRunView {
  incident: { id: string; title: string; canWrite: boolean; resolutionNote: string | null };
  checklist: { id: string; title: string; body: string };
  steps: ChecklistStep[];
  proposed: ProposedStep[];
  completed: Record<string, { by: string; at: Date; finding: string | null }>;
}

export interface ChecklistSummary {
  id: string;
  title: string;
  stepCount: number;
  doneCount: number;
  proposedCount: number;
}

export interface ChecklistDocument {
  id: string;
  title: string;
  body: string;
  service: string;
  canWrite: boolean;
  steps: ChecklistStep[];
  proposed: ProposedStep[];
  retired: ChecklistStep[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEP = 1000;
const MAX_FINDING = 2000;
const MAX_BODY = 20000;

function cleanText(value: string, max: number): string | null {
  const text = value.trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

async function stepsOf(db: ClientBase, checklistId: string, status: string) {
  const { rows } = await db.query<ChecklistStep>(
    `SELECT s.id, s.text, s.source_incident_id AS "sourceIncidentId", i.title AS "sourceIncidentTitle", s.added_by_name AS "addedBy",
       (SELECT count(*)::int FROM incidents f WHERE f.resolution_step_id = s.id) AS "fixedCount"
     FROM checklist_steps s LEFT JOIN incidents i ON i.id = s.source_incident_id
     WHERE s.runbook_id = $1 AND s.status = $2
     ORDER BY s.sort_order, s.created_at`,
    [checklistId, status],
  );
  return rows;
}

const asProposal = ({ id, text, sourceIncidentId, sourceIncidentTitle, addedBy }: ChecklistStep): ProposedStep => ({
  id,
  text,
  sourceIncidentId,
  sourceIncidentTitle,
  by: addedBy,
});

async function canWriteChecklist(db: ClientBase, checklistId: string): Promise<{ exists: boolean; canWrite: boolean; teamId?: string }> {
  const { rows } = await db.query<{ team_id: string; can_write: boolean }>(
    "SELECT team_id, app_is_writer(team_id) AS can_write FROM runbooks WHERE id = $1",
    [checklistId],
  );
  const row = rows[0];
  return row ? { exists: true, canWrite: row.can_write, teamId: row.team_id } : { exists: false, canWrite: false };
}

// ----- Using a checklist during an incident -----

export async function listChecklistsForIncident(db: ClientBase, incidentId: string): Promise<ChecklistSummary[]> {
  if (!UUID.test(incidentId)) return [];
  const { rows } = await db.query<ChecklistSummary>(
    `SELECT r.id, r.title,
       (SELECT count(*)::int FROM checklist_steps s WHERE s.runbook_id = r.id AND s.status = 'active') AS "stepCount",
       (SELECT count(*)::int FROM runbook_runs rr JOIN checklist_step_completions c ON c.run_id = rr.id
          JOIN checklist_steps s ON s.id = c.step_id AND s.status = 'active'
        WHERE rr.runbook_id = r.id AND rr.incident_id = i.id) AS "doneCount",
       (SELECT count(*)::int FROM checklist_steps s WHERE s.runbook_id = r.id AND s.status = 'proposed') AS "proposedCount"
     FROM incidents i JOIN runbooks r ON r.service_id = i.service_id
     WHERE i.id = $1
     ORDER BY r.title`,
    [incidentId],
  );
  return rows;
}

export async function getChecklistRun(db: ClientBase, incidentId: string, checklistId: string): Promise<ChecklistRunView | null> {
  if (!UUID.test(incidentId) || !UUID.test(checklistId)) return null;
  const incident = await getIncident(db, incidentId);
  if (!incident) return null;

  const { rows } = await db.query<{ id: string; title: string; body: string }>(
    `SELECT r.id, r.title, r.body_md AS body
     FROM runbooks r JOIN incidents i ON i.service_id = r.service_id
     WHERE r.id = $1 AND i.id = $2`,
    [checklistId, incidentId],
  );
  const checklist = rows[0];
  if (!checklist) return null;

  const done = await db.query<{ step_id: string; by: string; at: Date; finding: string | null }>(
    `SELECT c.step_id, c.completed_by_name AS by, c.completed_at AS at, c.finding
     FROM runbook_runs rr JOIN checklist_step_completions c ON c.run_id = rr.id
     WHERE rr.runbook_id = $1 AND rr.incident_id = $2`,
    [checklistId, incidentId],
  );
  const completed: ChecklistRunView["completed"] = {};
  for (const row of done.rows) completed[row.step_id] = { by: row.by, at: row.at, finding: row.finding };

  return {
    incident: { id: incident.id, title: incident.title, canWrite: incident.canWrite, resolutionNote: incident.resolutionNote },
    checklist,
    steps: await stepsOf(db, checklistId, "active"),
    proposed: (await stepsOf(db, checklistId, "proposed")).map(asProposal),
    completed,
  };
}

export async function completeStep(
  db: ClientBase,
  input: { incidentId: string; checklistId: string; stepId: string; finding: string; actor: Actor; now: Date },
): Promise<Result> {
  const { incidentId, checklistId, stepId, actor, now } = input;
  const view = await getChecklistRun(db, incidentId, checklistId);
  if (!view) return { ok: false, error: "not_found" };
  if (!view.incident.canWrite) return { ok: false, error: "forbidden" };
  const step = view.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: "invalid_step" };
  if (input.finding.trim().length > MAX_FINDING) return { ok: false, error: "invalid_text" };
  const finding = cleanText(input.finding, MAX_FINDING);

  const teamId = (await db.query<{ team_id: string }>("SELECT team_id FROM incidents WHERE id = $1", [incidentId])).rows[0]?.team_id;
  await db.query(
    `INSERT INTO runbook_runs (runbook_id, incident_id, team_id, started_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (incident_id, runbook_id) DO NOTHING`,
    [checklistId, incidentId, teamId, actor.id],
  );
  const runId = (await db.query<{ id: string }>("SELECT id FROM runbook_runs WHERE incident_id = $1 AND runbook_id = $2", [incidentId, checklistId]))
    .rows[0]?.id;

  // Primary key (run_id, step_id): a step can be completed once per incident.
  const inserted = await db.query(
    `INSERT INTO checklist_step_completions (run_id, team_id, step_id, finding, completed_by, completed_by_name, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, step_id) DO NOTHING`,
    [runId, teamId, stepId, finding, actor.id, actor.name, now],
  );
  if (inserted.rowCount !== 1) return { ok: false, error: "already_done" };

  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data) VALUES ($1, $2, 'runbook_step', $3, $4)`,
    [
      incidentId,
      teamId,
      actor.id,
      JSON.stringify({ runbook_id: checklistId, runbook_title: view.checklist.title, step_id: stepId, step_text: step.text, finding, actor_name: actor.name }),
    ],
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'checklist.step_completed', 'incident', $3)`,
    [actor.id, teamId, incidentId],
  );
  return { ok: true };
}

/** Proposes what fixed an incident as a new step, linked to that incident, for review. */
export async function proposeStep(db: ClientBase, input: { incidentId: string; checklistId: string; text: string; actor: Actor }): Promise<Result> {
  const { incidentId, checklistId, actor } = input;
  const view = await getChecklistRun(db, incidentId, checklistId);
  if (!view) return { ok: false, error: "not_found" };
  if (!view.incident.canWrite) return { ok: false, error: "forbidden" };
  const text = cleanText(input.text, MAX_STEP);
  if (!text) return { ok: false, error: "invalid_text" };

  const teamId = (await db.query<{ team_id: string }>("SELECT team_id FROM incidents WHERE id = $1", [incidentId])).rows[0]?.team_id;
  await db.query(
    `INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text, status, source_incident_id, added_by, added_by_name)
     VALUES ($1, $2, (SELECT coalesce(max(sort_order), 0) + 1 FROM checklist_steps WHERE runbook_id = $1), $3, 'proposed', $4, $5, $6)`,
    [checklistId, teamId, text, incidentId, actor.id, actor.name],
  );
  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data) VALUES ($1, $2, 'note', $3, $4)`,
    [incidentId, teamId, actor.id, JSON.stringify({ text: `Proposed for "${view.checklist.title}": ${text}`, actor_name: actor.name })],
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'checklist.step_proposed', 'checklist', $3)`,
    [actor.id, teamId, checklistId],
  );
  return { ok: true };
}

export async function reviewProposal(db: ClientBase, input: { checklistId: string; stepId: string; accept: boolean; actor: Actor }): Promise<Result> {
  const { checklistId, stepId, accept, actor } = input;
  if (!UUID.test(checklistId) || !UUID.test(stepId)) return { ok: false, error: "not_found" };
  const access = await canWriteChecklist(db, checklistId);
  if (!access.exists) return { ok: false, error: "not_found" };
  if (!access.canWrite) return { ok: false, error: "forbidden" };

  const updated = await db.query(
    `UPDATE checklist_steps SET status = $3, reviewed_by = $4, reviewed_at = now()
     WHERE id = $1 AND runbook_id = $2 AND status = 'proposed'`,
    [stepId, checklistId, accept ? "active" : "rejected", actor.id],
  );
  if (updated.rowCount !== 1) return { ok: false, error: "not_found" };
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, $3, 'checklist', $4)`,
    [actor.id, access.teamId, accept ? "checklist.step_accepted" : "checklist.step_rejected", checklistId],
  );
  return { ok: true };
}

// ----- Editing a checklist -----

/** Services the user may create checklists for (admin/responder of the owning team). */
export async function listWritableServices(db: ClientBase): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<{ id: string; name: string }>("SELECT id, name FROM services WHERE app_is_writer(team_id) ORDER BY name");
  return rows;
}

/** Creates a checklist; its "- [ ]" lines become the first steps. */
export async function createChecklist(
  db: ClientBase,
  input: { serviceId: string; title: string; body: string; actor: Actor },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { serviceId, actor } = input;
  if (!UUID.test(serviceId)) return { ok: false, error: "not_found" };
  const service = (await listWritableServices(db)).find((s) => s.id === serviceId);
  if (!service) return { ok: false, error: "forbidden" };
  const title = cleanText(input.title, 200);
  const body = cleanText(input.body, MAX_BODY);
  if (!title || !body) return { ok: false, error: "invalid_text" };

  const { rows } = await db.query<{ id: string; team_id: string }>(
    `INSERT INTO runbooks (team_id, service_id, title, body_md)
     SELECT team_id, id, $2, $3 FROM services WHERE id = $1
     RETURNING id, team_id`,
    [serviceId, title, body],
  );
  const created = rows[0];
  if (!created) return { ok: false, error: "not_found" };

  const steps = parseRunbook(body).steps;
  for (const [i, text] of steps.entries()) {
    await db.query(
      `INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text, status, added_by, added_by_name)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [created.id, created.team_id, i + 1, text, actor.id, actor.name],
    );
  }
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'checklist.created', 'checklist', $3)`,
    [actor.id, created.team_id, created.id],
  );
  return { ok: true, id: created.id };
}

export async function getChecklist(db: ClientBase, checklistId: string): Promise<ChecklistDocument | null> {
  if (!UUID.test(checklistId)) return null;
  const { rows } = await db.query<{ id: string; title: string; body: string; service: string; canWrite: boolean }>(
    `SELECT r.id, r.title, r.body_md AS body, s.name AS service, app_is_writer(r.team_id) AS "canWrite"
     FROM runbooks r JOIN services s ON s.id = r.service_id WHERE r.id = $1`,
    [checklistId],
  );
  const doc = rows[0];
  if (!doc) return null;
  return {
    ...doc,
    steps: await stepsOf(db, checklistId, "active"),
    proposed: (await stepsOf(db, checklistId, "proposed")).map(asProposal),
    retired: await stepsOf(db, checklistId, "retired"),
  };
}

export async function listChecklists(db: ClientBase): Promise<{ id: string; title: string; service: string; stepCount: number; proposedCount: number }[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.title, s.name AS service,
       (SELECT count(*)::int FROM checklist_steps c WHERE c.runbook_id = r.id AND c.status = 'active') AS "stepCount",
       (SELECT count(*)::int FROM checklist_steps c WHERE c.runbook_id = r.id AND c.status = 'proposed') AS "proposedCount"
     FROM runbooks r JOIN services s ON s.id = r.service_id
     ORDER BY s.name, r.title`,
  );
  return rows;
}

export async function updateChecklist(db: ClientBase, input: { checklistId: string; title: string; body: string; actor: Actor }): Promise<Result> {
  const { checklistId, actor } = input;
  if (!UUID.test(checklistId)) return { ok: false, error: "not_found" };
  const access = await canWriteChecklist(db, checklistId);
  if (!access.exists) return { ok: false, error: "not_found" };
  if (!access.canWrite) return { ok: false, error: "forbidden" };
  const title = cleanText(input.title, 200);
  const body = cleanText(input.body, MAX_BODY);
  if (!title || !body) return { ok: false, error: "invalid_text" };

  await db.query("UPDATE runbooks SET title = $2, body_md = $3 WHERE id = $1", [checklistId, title, body]);
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'checklist.edited', 'checklist', $3)`,
    [actor.id, access.teamId, checklistId],
  );
  return { ok: true };
}

export async function addStep(db: ClientBase, input: { checklistId: string; text: string; actor: Actor }): Promise<Result> {
  const { checklistId, actor } = input;
  if (!UUID.test(checklistId)) return { ok: false, error: "not_found" };
  const access = await canWriteChecklist(db, checklistId);
  if (!access.exists) return { ok: false, error: "not_found" };
  if (!access.canWrite) return { ok: false, error: "forbidden" };
  const text = cleanText(input.text, MAX_STEP);
  if (!text) return { ok: false, error: "invalid_text" };

  await db.query(
    `INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text, status, added_by, added_by_name)
     VALUES ($1, $2, (SELECT coalesce(max(sort_order), 0) + 1 FROM checklist_steps WHERE runbook_id = $1), $3, 'active', $4, $5)`,
    [checklistId, access.teamId, text, actor.id, actor.name],
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'checklist.step_added', 'checklist', $3)`,
    [actor.id, access.teamId, checklistId],
  );
  return { ok: true };
}

/** Retire instead of delete: history and earlier completions keep pointing at the step. */
export async function retireStep(db: ClientBase, input: { checklistId: string; stepId: string; actor: Actor }): Promise<Result> {
  const { checklistId, stepId, actor } = input;
  if (!UUID.test(checklistId) || !UUID.test(stepId)) return { ok: false, error: "not_found" };
  const access = await canWriteChecklist(db, checklistId);
  if (!access.exists) return { ok: false, error: "not_found" };
  if (!access.canWrite) return { ok: false, error: "forbidden" };

  const updated = await db.query(
    "UPDATE checklist_steps SET status = 'retired', retired_at = now() WHERE id = $1 AND runbook_id = $2 AND status = 'active'",
    [stepId, checklistId],
  );
  if (updated.rowCount !== 1) return { ok: false, error: "not_found" };
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'checklist.step_retired', 'checklist', $3)`,
    [actor.id, access.teamId, checklistId],
  );
  return { ok: true };
}
