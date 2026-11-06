import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { getChecklist } from "@/runbooks/repo";
import { ChecklistProse, Provenance } from "../../checklist-ui";
import { addStepAction, retireStepAction, reviewAction, updateChecklistAction } from "../actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  forbidden: "You have read-only access to this team.",
  invalid_text: "Please fill in the text (titles up to 200, steps up to 1000 characters).",
  not_found: "Not found.",
};

export default async function ChecklistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const doc = await withUser(getPool(), user.id, (db) => getChecklist(db, id));
  if (!doc) notFound();

  const hidden = <input type="hidden" name="checklistId" value={doc.id} />;

  return (
    <main className="stack">
      <p>
        <Link href="/checklists">← All checklists</Link>
      </p>
      <p className="muted small">Response checklist · {doc.service}</p>
      <h1>{doc.title}</h1>
      {error ? <p role="alert" className="error">{ERRORS[error] ?? "That change is not allowed."}</p> : null}

      <ChecklistProse body={doc.body} />

      <h2>Steps</h2>
      {doc.steps.length === 0 ? <p className="muted">No steps yet.</p> : null}
      <ol className="stack">
        {doc.steps.map((step) => (
          <li key={step.id} className="card row">
            <span className="grow">{step.text}</span>
            <Provenance step={step} />
            {doc.canWrite ? (
              <form action={retireStepAction}>
                {hidden}
                <input type="hidden" name="stepId" value={step.id} />
                <button type="submit" className="secondary">
                  Retire
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ol>

      {doc.canWrite ? (
        <form action={addStepAction} className="row">
          {hidden}
          <input name="text" className="grow" required maxLength={1000} placeholder="Add a step" />
          <button type="submit">Add step</button>
        </form>
      ) : null}

      {doc.proposed.length > 0 ? (
        <>
          <h2>Proposed from incidents</h2>
          {doc.proposed.map((step) => (
            <div key={step.id} className="card row">
              <span className="grow">{step.text}</span>
              <Provenance step={{ ...step, addedBy: step.by }} />
              {doc.canWrite
                ? (["accept", "reject"] as const).map((decision) => (
                    <form key={decision} action={reviewAction}>
                      {hidden}
                      <input type="hidden" name="stepId" value={step.id} />
                      <input type="hidden" name="decision" value={decision} />
                      <button type="submit" className={decision === "reject" ? "secondary" : undefined}>
                        {decision === "accept" ? "Accept" : "Reject"}
                      </button>
                    </form>
                  ))
                : null}
            </div>
          ))}
        </>
      ) : null}

      {doc.retired.length > 0 ? (
        <details>
          <summary className="muted">Retired steps ({doc.retired.length})</summary>
          <ul>
            {doc.retired.map((step) => (
              <li key={step.id} className="muted">
                {step.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {doc.canWrite ? (
        <>
          <h2>Edit document</h2>
          <form action={updateChecklistAction} className="card stack">
            {hidden}
            <label className="stack">
              <span>Title</span>
              <input name="title" required maxLength={200} defaultValue={doc.title} />
            </label>
            <label className="stack">
              <span>Document (Markdown). Steps are managed above; &quot;- [ ]&quot; lines here are not shown as steps.</span>
              <textarea name="body" required rows={10} maxLength={20000} defaultValue={doc.body} />
            </label>
            <div>
              <button type="submit">Save</button>
            </div>
          </form>
        </>
      ) : (
        <p className="muted">You have read-only access to this team.</p>
      )}
    </main>
  );
}
