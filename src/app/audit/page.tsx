import { requireUser } from "@/auth/current-user";
import { listAudit } from "@/audit/repo";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;

export default async function AuditPage() {
  const user = await requireUser();
  const entries = await withUser(getPool(), user.id, (db) => listAudit(db, { limit: 200 }));

  return (
    <main className="stack">
      <h1>Audit log</h1>
      <p className="muted">
        Append-only record of every change and export for the teams you administer. Entries hold ids and actions, never personal
        data. Only team admins see this page.
      </p>
      <form action="/audit/export" method="post">
        <button type="submit">Export CSV</button>
      </form>
      {entries.length === 0 ? (
        <p className="muted">No entries (or you are not an admin of any team).</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Team</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td className="muted small">{fmt(e.occurredAt)}</td>
                <td>{e.team ?? "—"}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td className="small">
                  {e.entityType} {e.entityId.slice(0, 36)}
                </td>
                <td className="muted small">{e.actorUserId ? e.actorUserId.slice(0, 8) : "system"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
