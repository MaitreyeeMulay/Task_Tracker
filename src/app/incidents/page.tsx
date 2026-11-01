import Link from "next/link";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { listIncidents } from "@/incidents/repo";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const user = await requireUser();
  const incidents = await withUser(getPool(), user.id, (db) => listIncidents(db));

  return (
    <main className="stack">
      <h1>Incidents</h1>
      {incidents.length === 0 ? (
        <p className="muted">No incidents for your teams.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>Service</th>
              <th>Status</th>
              <th>Alerts</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.id}>
                <td>
                  <span className={`badge sev-${incident.severity.toLowerCase()}`}>{incident.severity}</span>
                </td>
                <td>
                  <Link href={`/incidents/${incident.id}`}>{incident.title}</Link>
                </td>
                <td>{incident.service}</td>
                <td>
                  <span className={`badge status-${incident.status}`}>{incident.status}</span>
                </td>
                <td>{incident.alertCount}</td>
                <td>{incident.openedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
