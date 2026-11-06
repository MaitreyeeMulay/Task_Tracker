"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { changeStatus } from "@/incidents/repo";
import { resolveIncident, type Resolution } from "@/incidents/resolve";
import { getPool } from "@/lib/db";

// Server actions are POST-only and Next.js checks the Origin header against the
// host, which together with the SameSite=Lax session cookie blocks cross-site
// requests (CSRF). The database still decides whether this user may write.

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function back(incidentId: string, result: { ok: boolean; error?: string }): never {
  revalidatePath(`/incidents/${incidentId}`);
  redirect(result.ok ? `/incidents/${incidentId}` : `/incidents/${incidentId}?error=${encodeURIComponent(result.error ?? "error")}`);
}

/** Acknowledge / mitigate. Resolving goes through resolveAction. */
export async function changeStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const incidentId = field(formData, "incidentId");
  const to = field(formData, "to");
  if (to === "resolved") back(incidentId, { ok: false, error: "use_resolve" });

  const result = await withUser(getPool(), user.id, (db) =>
    changeStatus(db, { incidentId, to, actor: { id: user.id, name: user.name }, now: new Date() }),
  );
  console.log(JSON.stringify({ event: "incident_status_change", user_id: user.id, incident_id: incidentId.slice(0, 36), ok: result.ok }));
  back(incidentId, result);
}

/** Resolve, answering "what resolved it?". */
export async function resolveAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const incidentId = field(formData, "incidentId");
  const outcome = field(formData, "outcome");

  let resolution: Resolution;
  if (outcome === "checklist_step") {
    resolution = { kind: "checklist_step", stepId: field(formData, "stepId") };
  } else if (outcome === "other_fix") {
    const proposeTo = field(formData, "proposeTo");
    resolution = { kind: "other_fix", text: field(formData, "otherFix"), ...(proposeTo ? { proposeTo } : {}) };
  } else if (outcome === "self_resolved") {
    resolution = { kind: "self_resolved", note: field(formData, "selfNote") };
  } else {
    back(incidentId, { ok: false, error: "choose_outcome" });
  }

  const result = await withUser(getPool(), user.id, (db) =>
    resolveIncident(db, { incidentId, actor: { id: user.id, name: user.name }, now: new Date(), resolution }),
  );
  console.log(JSON.stringify({ event: "incident_resolved", user_id: user.id, incident_id: incidentId.slice(0, 36), outcome, ok: result.ok }));
  back(incidentId, result);
}
