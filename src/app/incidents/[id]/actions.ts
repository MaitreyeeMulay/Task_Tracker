"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { changeStatus } from "@/incidents/repo";
import { getPool } from "@/lib/db";
import { proposeStep } from "@/runbooks/repo";

class ProposalFailed extends Error {}

// Server actions are POST-only and Next.js checks the Origin header against the
// host, which together with the SameSite=Lax session cookie blocks cross-site
// requests (CSRF). The database still decides whether this user may write.
export async function changeStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const incidentId = String(formData.get("incidentId") ?? "");
  const to = String(formData.get("to") ?? "");
  const resolutionNote = String(formData.get("resolutionNote") ?? "");
  const proposeTo = String(formData.get("proposeTo") ?? "");
  const actor = { id: user.id, name: user.name };

  // Resolving and proposing the fix happen in one transaction: both or neither.
  let result: { ok: true } | { ok: false; error: string };
  try {
    result = await withUser(getPool(), user.id, async (db) => {
      const changed = await changeStatus(db, { incidentId, to, actor, now: new Date(), resolutionNote });
      if (changed.ok && to === "resolved" && proposeTo && resolutionNote.trim()) {
        const proposed = await proposeStep(db, { incidentId, checklistId: proposeTo, text: resolutionNote, actor });
        if (!proposed.ok) throw new ProposalFailed();
      }
      return changed;
    });
  } catch (error) {
    if (!(error instanceof ProposalFailed)) throw error;
    result = { ok: false, error: "proposal_failed" };
  }
  console.log(JSON.stringify({ event: "incident_status_change", user_id: user.id, incident_id: incidentId.slice(0, 36), ok: result.ok }));

  revalidatePath(`/incidents/${incidentId}`);
  redirect(result.ok ? `/incidents/${incidentId}` : `/incidents/${incidentId}?error=${encodeURIComponent(result.error)}`);
}
