import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getIncident } from "@/incidents/repo";
import { listChecklistsForIncident } from "@/runbooks/repo";
import { allowedNextStatuses } from "@/incidents/status";
import { getPool } from "@/lib/db";
import { changeStatusAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  forbidden: "You can view this incident but not change it.",
  conflict: "Someone else changed this incident first. Check the latest status and try again.",
  not_found: "Incident not found.",
  proposal_failed: "Nothing was changed: the fix could not be proposed as a checklist step (it must be 1–1000 characters).",
};

const ACTION_LABEL: Record<string, string> = {
  acknowledged: "Acknowledge",
  mitigated: "Mark mitigated",
};

const KIND_LABEL: Record<string, string> = {
  alert_received: "alert received",
  alert_resolved: "alert cleared",
  status_changed: "status changed",
  runbook_step: "checklist step",
  note: "note",
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
  const { incident, checklists } = await withUser(getPool(), user.id, async (db) => ({
    incident: await getIncident(db, id),
    checklists: await listChecklistsForIncident(db, id),
  }));
  if (!incident) notFound();

  const next = incident.canWrite ? allowedNextStatuses(incident.status) : [];
  const message = error ? (ERRORS[error] ?? "That change is not allowed.") : null;
  const hidden = <input type="hidden" name="incidentId" value={incident.id} />;

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
      {incident.resolutionNote ? (
        <p className="card">
          <strong>What fixed it:</strong> {incident.resolutionNote}
        </p>
      ) : null}

      {next.filter((to) => to !== "resolved").length > 0 ? (
        <div className="row">
          {next
            .filter((to) => to !== "resolved")
            .map((to) => (
              <form key={to} action={changeStatusAction}>
                {hidden}
                <input type="hidden" name="to" value={to} />
                <button type="submit">{ACTION_LABEL[to]}</button>
              </form>
            ))}
        </div>
      ) : null}

      {next.includes("resolved") ? (
        <form action={changeStatusAction} className="card stack">
          {hidden}
          <input type="hidden" name="to" value="resolved" />
          <label className="stack">
            <strong>Resolve: what fixed it?</strong>
            <textarea name="resolutionNote" rows={2} maxLength={1000} placeholder="e.g. Restarted the payment worker" />
          </label>
          {checklists.length > 0 ? (
            <label className="row">
              <span>Propose it as a step for</span>
              <select name="proposeTo" defaultValue="">
                <option value="">— don&apos;t propose —</option>
                {checklists.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div>
            <button type="submit">Resolve</button>
          </div>
        </form>
      ) : null}

      {!incident.canWrite ? <p className="muted">You have read-only access to this team.</p> : null}

      <h2>Response checklists</h2>
      {checklists.length === 0 ? (
        <p className="muted">
          No checklist for {incident.service} yet. <Link href="/checklists">Create one</Link>
        </p>
      ) : (
        <ul>
          {checklists.map((c) => (
            <li key={c.id}>
              <Link href={`/incidents/${incident.id}/checklists/${c.id}`}>{c.title}</Link>{" "}
              <span className="muted">
                ({c.doneCount}/{c.stepCount} steps{c.proposedCount ? `, ${c.proposedCount} proposed` : ""})
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Timeline</h2>
      <ol className="timeline">
        {incident.timeline.map((entry, i) => (
          <li key={i}>
            <span className="muted">{fmt(entry.occurredAt)}</span> <strong>{KIND_LABEL[entry.kind] ?? entry.kind}</strong>
            {entry.detail ? <> · {entry.detail}</> : null}
            {entry.actorName ? <> · by {entry.actorName}</> : null}
          </li>
        ))}
      </ol>
    </main>
  );
}
