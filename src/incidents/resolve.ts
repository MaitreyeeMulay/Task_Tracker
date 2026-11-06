import type { ClientBase } from "pg";
import { getChecklistRun, proposeStep } from "../runbooks/repo.ts";
import { changeStatus, getIncident } from "./repo.ts";

// Resolving asks "what resolved it?" (owner request 2026-11-06):
//   checklist_step  a step completed on this incident fixed it; the step's
//                   "fixed N incidents" count goes up
//   other_fix       something else fixed it; optionally proposed as a new step
//                   for one of the incident's checklists (reviewed later)
//   self_resolved   it recovered on its own / was a false alarm
// Everything happens in the caller's transaction (as app_rw), so either all of
// it is recorded or none of it.

export type Resolution =
  | { kind: "checklist_step"; stepId: string }
  | { kind: "other_fix"; text: string; proposeTo?: string }
  | { kind: "self_resolved"; note: string };

type Result = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(text: string, max: number): string | null {
  const value = text.trim();
  return value.length >= 1 && value.length <= max ? value : null;
}

/** Steps completed on this incident: the choices for "a checklist step fixed it". */
export async function listCompletedSteps(db: ClientBase, incidentId: string): Promise<{ stepId: string; text: string; checklistTitle: string }[]> {
  if (!UUID.test(incidentId)) return [];
  const { rows } = await db.query<{ stepId: string; text: string; checklistTitle: string }>(
    `SELECT s.id AS "stepId", s.text, r.title AS "checklistTitle"
     FROM runbook_runs rr
     JOIN checklist_step_completions c ON c.run_id = rr.id
     JOIN checklist_steps s ON s.id = c.step_id
     JOIN runbooks r ON r.id = rr.runbook_id
     WHERE rr.incident_id = $1
     ORDER BY r.title, s.sort_order`,
    [incidentId],
  );
  return rows;
}

export async function resolveIncident(
  db: ClientBase,
  { incidentId, actor, now, resolution }: { incidentId: string; actor: { id: string; name: string }; now: Date; resolution: Resolution },
): Promise<Result> {
  const incident = await getIncident(db, incidentId);
  if (!incident) return { ok: false, error: "not_found" };
  if (!incident.canWrite) return { ok: false, error: "forbidden" };

  // Validate everything before changing anything.
  let note: string | null = null;
  let stepId: string | null = null;
  let detail: string;
  if (resolution.kind === "checklist_step") {
    if (!UUID.test(resolution.stepId)) return { ok: false, error: "step_not_completed" };
    const { rows } = await db.query<{ text: string; title: string }>(
      `SELECT s.text, r.title
       FROM runbook_runs rr
       JOIN checklist_step_completions c ON c.run_id = rr.id
       JOIN checklist_steps s ON s.id = c.step_id
       JOIN runbooks r ON r.id = rr.runbook_id
       WHERE rr.incident_id = $1 AND c.step_id = $2`,
      [incidentId, resolution.stepId],
    );
    const step = rows[0];
    if (!step) return { ok: false, error: "step_not_completed" };
    stepId = resolution.stepId;
    note = step.text;
    detail = `Resolved by checklist step "${step.text}" (${step.title})`;
  } else if (resolution.kind === "other_fix") {
    note = clean(resolution.text, 1000);
    if (!note) return { ok: false, error: "invalid_text" };
    if (resolution.proposeTo && !(await getChecklistRun(db, incidentId, resolution.proposeTo))) return { ok: false, error: "not_found" };
    detail = `Resolved by something else: ${note}`;
  } else {
    note = clean(resolution.note, 1000);
    detail = `Resolved: recovered on its own / false alarm${note ? ` — ${note}` : ""}`;
  }

  const changed = await changeStatus(db, { incidentId, to: "resolved", actor, now });
  if (!changed.ok) return changed;

  await db.query(
    "UPDATE incidents SET resolution_kind = $2, resolution_step_id = $3, resolution_note = $4 WHERE id = $1",
    [incidentId, resolution.kind, stepId, note],
  );
  const teamId = (await db.query<{ team_id: string }>("SELECT team_id FROM incidents WHERE id = $1", [incidentId])).rows[0]?.team_id;
  await db.query(
    `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id, data) VALUES ($1, $2, 'note', $3, $4)`,
    [incidentId, teamId, actor.id, JSON.stringify({ text: detail, actor_name: actor.name })],
  );

  if (resolution.kind === "other_fix" && resolution.proposeTo && note) {
    const proposed = await proposeStep(db, { incidentId, checklistId: resolution.proposeTo, text: note, actor });
    // Validated above; if it still fails, throw so the caller's transaction rolls back.
    if (!proposed.ok) throw new Error("proposal failed after validation");
  }
  return { ok: true };
}
