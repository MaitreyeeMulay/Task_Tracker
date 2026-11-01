import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getIncident } from "@/incidents/repo";
import { listRunbooksForIncident } from "@/runbooks/repo";
import { allowedNextStatuses } from "@/incidents/status";
import { getPool } from "@/lib/db";
import { changeStatusAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  forbidden: "You can view this incident but not change it.",
  conflict: "Someone else changed this incident first. Check the latest status and try again.",
  not_found: "Incident not found.",
};

const ACTION_LABEL: Record<string, string> = {
  acknowledged: "Acknowledge",
  mitigated: "Mark mitigated",
  resolved: "Resolve",
};

const fmt = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;

export default async function IncidentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const data = await withUser(getPool(), user.id, async (db) => ({
    incident: await getIncident(db, id),
    runbooks: await listRunbooksForIncident(db, id),
  }));
  const { incident, runbooks } = data;
  if (!incident) notFound();

  const next = incident.canWrite ? allowedNextStatuses(incident.status) : [];
  const message = error ? (ERRORS[error] ?? "That change is not allowed.") : null;

  return (
    <main className="stack">
      <p>
        <Link href="/incidents">← All incidents</Link>
      </p>
      <h1>{incident.title}</h1>
      <p className="row">
        <span className={`badge sev-${incident.severity.toLowerCase()}`}>{incident.severity}</span>
        <span className={`badge status-${incident.status}`}>{incident.status}</span>
        <span className="muted">
          {incident.service} · {incident.alertCount} alert{incident.alertCount === 1 ? "" : "s"} · opened {fmt(incident.openedAt)}
        </span>
      </p>

      {message ? <p role="alert" className="error">{message}</p> : null}

      {next.length > 0 ? (
        <div className="row">
          {next.map((to) => (
            <form key={to} action={changeStatusAction}>
              <input type="hidden" name="incidentId" value={incident.id} />
              <input type="hidden" name="to" value={to} />
              <button type="submit">{ACTION_LABEL[to]}</button>
            </form>
          ))}
        </div>
      ) : !incident.canWrite ? (
        <p className="muted">You have read-only access to this team.</p>
      ) : null}

      <h2>Runbooks</h2>
      {runbooks.length === 0 ? (
        <p className="muted">No runbooks for {incident.service}.</p>
      ) : (
        <ul>
          {runbooks.map((rb) => (
            <li key={rb.id}>
              <Link href={`/incidents/${incident.id}/runbooks/${rb.id}`}>{rb.title}</Link>{" "}
              <span className="muted">
                ({rb.doneCount}/{rb.stepCount} steps)
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Timeline</h2>
      <ol className="timeline">
        {incident.timeline.map((entry, i) => (
          <li key={i}>
            <span className="muted">{fmt(entry.occurredAt)}</span> <strong>{entry.kind.replace("_", " ")}</strong>
            {entry.detail ? <> · {entry.detail}</> : null}
            {entry.actorName ? <> · by {entry.actorName}</> : null}
          </li>
        ))}
      </ol>
    </main>
  );
}
