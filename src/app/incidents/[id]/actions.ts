"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { changeStatus } from "@/incidents/repo";
import { getPool } from "@/lib/db";

// Server actions are POST-only and Next.js checks the Origin header against the
// host, which together with the SameSite=Lax session cookie blocks cross-site
// requests (CSRF). The database still decides whether this user may write.
export async function changeStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const incidentId = String(formData.get("incidentId") ?? "");
  const to = String(formData.get("to") ?? "");

  const result = await withUser(getPool(), user.id, (db) =>
    changeStatus(db, { incidentId, to, actor: { id: user.id, name: user.name }, now: new Date() }),
  );
  console.log(JSON.stringify({ event: "incident_status_change", user_id: user.id, incident_id: incidentId.slice(0, 36), ok: result.ok }));

  revalidatePath(`/incidents/${incidentId}`);
  redirect(result.ok ? `/incidents/${incidentId}` : `/incidents/${incidentId}?error=${encodeURIComponent(result.error)}`);
}
