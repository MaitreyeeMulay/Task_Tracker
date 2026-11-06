import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getIncident } from "@/incidents/repo";
import { listChecklistsForIncident } from "@/runbooks/repo";
import { allowedNextStatuses } from "@/incidents/status";
import { getPool } from "@/lib/db";
import { changeStatusAction, resolveAction } from "./actions";
import { listCompletedSteps } from "@/incidents/resolve";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  forbidden: "You can view this incident but not change it.",
  conflict: "Someone else changed this incident first. Check the latest status and try again.",
  not_found: "Incident not found.",
  invalid_text: "Please describe what fixed it (up to 1000 characters).",
  step_not_completed: "Pick a checklist step that was completed on this incident.",
  choose_outcome: "Choose what resolved it.",
  use_resolve: "Use the Resolve form.",
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
  const { incident, checklists, completedSteps } = await withUser(getPool(), user.id, async (db) => ({
    incident: await getIncident(db, id),
    checklists: await listChecklistsForIncident(db, id),
    completedSteps: await listCompletedSteps(db, id),
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
      {incident.status === "resolved" && (incident.resolutionKind || incident.resolutionNote) ? (
        <p className="card">
          <strong>
            {incident.resolutionKind === "checklist_step"
              ? "Resolved by checklist step:"
              : incident.resolutionKind === "self_resolved"
                ? "Recovered on its own / false alarm"
                : "Resolved by something else:"}
          </strong>{" "}
          {incident.resolutionNote}
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
        <form action={resolveAction} className="card stack">
          {hidden}
          <strong>Resolve: what resolved it?</strong>

          {completedSteps.length > 0 ? (
            <fieldset className="stack">
              <label className="row">
                <input type="radio" name="outcome" value="checklist_step" required />
                <span>A checklist step fixed it</span>
              </label>
              <select name="stepId" defaultValue={completedSteps.at(-1)?.stepId}>
                {completedSteps.map((s) => (
                  <option key={s.stepId} value={s.stepId}>
                    {s.text} ({s.checklistTitle})
                  </option>
                ))}
              </select>
            </fieldset>
          ) : null}

          <fieldset className="stack">
            <label className="row">
              <input type="radio" name="outcome" value="other_fix" required />
              <span>Something else fixed it</span>
            </label>
            <textarea name="otherFix" rows={2} maxLength={1000} placeholder="e.g. Restarted the payment worker" />
            {checklists.length > 0 ? (
              <label className="row">
                <span>Add it to a checklist as a proposed step:</span>
                <select name="proposeTo" defaultValue={checklists[0]?.id ?? ""}>
                  <option value="">— don&apos;t add —</option>
                  {checklists.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>

          <fieldset className="stack">
            <label className="row">
              <input type="radio" name="outcome" value="self_resolved" required />
              <span>It recovered on its own / false alarm</span>
            </label>
            <input name="selfNote" maxLength={1000} placeholder="Note (optional)" />
          </fieldset>

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
