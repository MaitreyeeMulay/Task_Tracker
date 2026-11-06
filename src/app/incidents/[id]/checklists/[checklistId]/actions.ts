"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { completeStep, proposeStep, reviewProposal } from "@/runbooks/repo";

// POST-only server actions (Origin checked by Next.js) + SameSite=Lax cookie.
// The database (RLS) is the real gate for every write below.

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function back(incidentId: string, checklistId: string, result: { ok: boolean; error?: string }): never {
  const page = `/incidents/${incidentId}/checklists/${checklistId}`;
  revalidatePath(page);
  redirect(result.ok ? page : `${page}?error=${encodeURIComponent(result.error ?? "error")}`);
}

export async function completeStepAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const [incidentId, checklistId] = [field(formData, "incidentId"), field(formData, "checklistId")];
  const result = await withUser(getPool(), user.id, (db) =>
    completeStep(db, {
      incidentId,
      checklistId,
      stepId: field(formData, "stepId"),
      finding: field(formData, "finding"),
      actor: { id: user.id, name: user.name },
      now: new Date(),
    }),
  );
  console.log(JSON.stringify({ event: "checklist_step_completed", user_id: user.id, ok: result.ok }));
  back(incidentId, checklistId, result);
}

export async function proposeStepAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const [incidentId, checklistId] = [field(formData, "incidentId"), field(formData, "checklistId")];
  const result = await withUser(getPool(), user.id, (db) =>
    proposeStep(db, { incidentId, checklistId, text: field(formData, "text"), actor: { id: user.id, name: user.name } }),
  );
  back(incidentId, checklistId, result);
}

export async function reviewProposalAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const [incidentId, checklistId] = [field(formData, "incidentId"), field(formData, "checklistId")];
  const result = await withUser(getPool(), user.id, (db) =>
    reviewProposal(db, { checklistId, stepId: field(formData, "stepId"), accept: field(formData, "decision") === "accept", actor: { id: user.id, name: user.name } }),
  );
  back(incidentId, checklistId, result);
}
