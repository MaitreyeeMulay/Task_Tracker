"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { reviewNotification, type ReviewDecision } from "@/notify/review";

// POST-only server action (Origin checked) + SameSite=Lax cookie; RLS limits it to team admins.
export async function reviewAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const notificationId = String(formData.get("notificationId") ?? "");
  const decision = String(formData.get("decision") ?? "") as ReviewDecision;
  const result = await withUser(getPool(), user.id, (db) =>
    reviewNotification(db, { notificationId, decision, actor: { id: user.id, name: user.name } }),
  );
  console.log(JSON.stringify({ event: "notification_reviewed", user_id: user.id, notification_id: notificationId.slice(0, 18), ok: result.ok }));
  revalidatePath("/notifications");
  redirect(result.ok ? "/notifications" : `/notifications?error=${encodeURIComponent(result.error)}`);
}
