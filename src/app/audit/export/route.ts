import { getCurrentUser } from "@/auth/current-user";
import { exportAudit } from "@/audit/repo";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /audit/export → CSV download of the admin's teams' audit trail.
// POST (not GET) so the proxy's CSRF check applies; the export is itself audited.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  try {
    const { csv, count } = await withUser(getPool(), user.id, (db) => exportAudit(db, { actor: user, now: new Date() }));
    console.log(JSON.stringify({ event: "audit_exported", user_id: user.id, rows: count }));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if ((error as Error).message.includes("not an admin")) return new Response("Forbidden", { status: 403 });
    throw error;
  }
}
