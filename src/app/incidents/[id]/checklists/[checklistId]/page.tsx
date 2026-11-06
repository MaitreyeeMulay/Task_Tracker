import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { getChecklistRun } from "@/runbooks/repo";
import { ChecklistProse, FixedCount, Provenance } from "../../../../checklist-ui";
import { completeStepAction, proposeStepAction, reviewProposalAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  forbidden: "You have read-only access to this team.",
  already_done: "That step was already completed.",
  invalid_step: "That step no longer exists.",
  invalid_text: "Please enter between 1 and 1000 characters.",
  not_found: "Not found.",
  incident_resolved: "This incident is already resolved, so steps can no longer be completed.",
};

const fmt = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

export default async function ChecklistRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; checklistId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id, checklistId }, { error }] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const view = await withUser(getPool(), user.id, (db) => getChecklistRun(db, id, checklistId));
  if (!view) notFound();

  const { incident, checklist, steps, proposed, completed } = view;
  const doneCount = steps.filter((s) => completed[s.id]).length;
  const isOpen = incident.status !== "resolved";
  // Ticking steps is work on an open incident; it never resolves anything.
  const canTick = incident.canWrite && isOpen;
  const allDone = steps.length > 0 && doneCount === steps.length;
  const hidden = (
    <>
      <input type="hidden" name="incidentId" value={incident.id} />
      <input type="hidden" name="checklistId" value={checklist.id} />
    </>
  );

  return (
    <main className="stack">
      <p className="row">
        <Link href={`/incidents/${incident.id}`}>← {incident.title}</Link>
        <span className="muted">·</span>
        <Link href={`/checklists/${checklist.id}`}>Edit checklist</Link>
      </p>
      <p className="muted small">Response checklist</p>
      <h1>{checklist.title}</h1>
      <p className="muted">
        {doneCount} of {steps.length} steps done{incident.canWrite ? "" : " · read-only"}
      </p>
      {error ? <p role="alert" className="error">{ERRORS[error] ?? "That change is not allowed."}</p> : null}
      {!isOpen ? (
        <p className="card">
          This incident is <strong>resolved</strong>. The checklist is shown as it was worked; steps can no longer be completed.
        </p>
      ) : allDone ? (
        <p className="card">
          All steps are done, but the incident is <strong>still open</strong>. If the problem persists, add what you try next as a step
          below. Resolve the incident from <Link href={`/incidents/${incident.id}`}>its page</Link> once it is actually fixed.
        </p>
      ) : null}

      <ChecklistProse body={checklist.body} />

      <h2>Steps</h2>
      {steps.length === 0 ? <p className="muted">No steps yet.</p> : null}
      {steps.map((step) => {
        const done = completed[step.id];
        return (
          <div key={step.id} className={`step card stack ${done ? "done" : ""}`}>
            <div className="row">
              <span aria-hidden="true">{done ? "✓" : "○"}</span>
              <span className="grow">{step.text}</span>
              <FixedCount count={step.fixedCount} />
              <Provenance step={step} />
            </div>
            {done ? (
              <p className="muted small">
                {done.by} · {fmt(done.at)}
                {done.finding ? <> · Found: {done.finding}</> : null}
              </p>
            ) : canTick ? (
              <form action={completeStepAction} className="row">
                {hidden}
                <input type="hidden" name="stepId" value={step.id} />
                <input name="finding" className="grow" maxLength={2000} placeholder="What did you find? (optional)" />
                <button type="submit">Mark done</button>
              </form>
            ) : null}
          </div>
        );
      })}

      {incident.canWrite ? (
        <>
          <h2>Did something else help?</h2>
          <form action={proposeStepAction} className="row">
            {hidden}
            <input name="text" className="grow" required maxLength={1000} defaultValue={incident.resolutionNote ?? ""} placeholder="e.g. Restart the payment worker" />
            <button type="submit">Propose as a step</button>
          </form>
          <p className="muted small">Proposals are linked to this incident and join the checklist once a responder accepts them.</p>
        </>
      ) : null}

      {proposed.length > 0 ? (
        <>
          <h2>Proposed steps</h2>
          {proposed.map((step) => (
            <div key={step.id} className="card row">
              <span className="grow">{step.text}</span>
              <Provenance step={{ ...step, addedBy: step.by }} />
              {incident.canWrite ? (
                <>
                  {(["accept", "reject"] as const).map((decision) => (
                    <form key={decision} action={reviewProposalAction}>
                      {hidden}
                      <input type="hidden" name="stepId" value={step.id} />
                      <input type="hidden" name="decision" value={decision} />
                      <button type="submit" className={decision === "reject" ? "secondary" : undefined}>
                        {decision === "accept" ? "Accept" : "Reject"}
                      </button>
                    </form>
                  ))}
                </>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </main>
  );
}
