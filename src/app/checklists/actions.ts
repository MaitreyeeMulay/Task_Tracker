"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { addStep, createChecklist, retireStep, reviewProposal, updateChecklist } from "@/runbooks/repo";

// POST-only server actions (Origin checked by Next.js) + SameSite=Lax cookie.
// RLS is the real gate: only the owning team's admins/responders can write.

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function back(checklistId: string, result: { ok: boolean; error?: string }): never {
  const page = `/checklists/${checklistId}`;
  revalidatePath(page);
  redirect(result.ok ? page : `${page}?error=${encodeURIComponent(result.error ?? "error")}`);
}

async function asUser<T>(fn: (actor: { id: string; name: string }, db: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const user = await requireUser();
  return withUser(getPool(), user.id, (db) => fn({ id: user.id, name: user.name }, db));
}

export async function createChecklistAction(formData: FormData): Promise<void> {
  const result = await asUser((actor, db) =>
    createChecklist(db, { serviceId: field(formData, "serviceId"), title: field(formData, "title"), body: field(formData, "body"), actor }),
  );
  revalidatePath("/checklists");
  redirect(result.ok ? `/checklists/${result.id}` : `/checklists?error=${encodeURIComponent(result.error)}`);
}

export async function updateChecklistAction(formData: FormData): Promise<void> {
  const checklistId = field(formData, "checklistId");
  back(checklistId, await asUser((actor, db) => updateChecklist(db, { checklistId, title: field(formData, "title"), body: field(formData, "body"), actor })));
}

export async function addStepAction(formData: FormData): Promise<void> {
  const checklistId = field(formData, "checklistId");
  back(checklistId, await asUser((actor, db) => addStep(db, { checklistId, text: field(formData, "text"), actor })));
}

export async function retireStepAction(formData: FormData): Promise<void> {
  const checklistId = field(formData, "checklistId");
  back(checklistId, await asUser((actor, db) => retireStep(db, { checklistId, stepId: field(formData, "stepId"), actor })));
}

export async function reviewAction(formData: FormData): Promise<void> {
  const checklistId = field(formData, "checklistId");
  back(
    checklistId,
    await asUser((actor, db) => reviewProposal(db, { checklistId, stepId: field(formData, "stepId"), accept: field(formData, "decision") === "accept", actor })),
  );
}
