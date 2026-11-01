"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { completeStep } from "@/runbooks/repo";

// POST-only server action (Origin checked by Next.js) + SameSite=Lax cookie; RLS is the real gate.
export async function completeStepAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const incidentId = String(formData.get("incidentId") ?? "");
  const runbookId = String(formData.get("runbookId") ?? "");
  const stepIndex = Number(formData.get("step"));

  const result = await withUser(getPool(), user.id, (db) =>
    completeStep(db, { incidentId, runbookId, stepIndex, actor: { id: user.id, name: user.name }, now: new Date() }),
  );
  console.log(JSON.stringify({ event: "runbook_step", user_id: user.id, incident_id: incidentId.slice(0, 36), ok: result.ok }));

  const page = `/incidents/${incidentId}/runbooks/${runbookId}`;
  revalidatePath(page);
  redirect(result.ok ? page : `${page}?error=${encodeURIComponent(result.error)}`);
}
