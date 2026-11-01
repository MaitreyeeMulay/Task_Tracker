import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { parseRunbook, type Block } from "@/runbooks/markdown";
import { getRunbookForIncident, type RunbookView } from "@/runbooks/repo";
import { completeStepAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  forbidden: "You can view this runbook but not complete steps.",
  already_done: "That step was already completed.",
  invalid_step: "That step does not exist.",
  not_found: "Runbook not found.",
};

const fmt = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

// Every block renders as React text: runbook content can never become HTML.
function RunbookBlock({ block, view }: { block: Block; view: RunbookView }) {
  switch (block.type) {
    case "heading":
      return block.level === 1 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
    case "paragraph":
      return <p>{block.text}</p>;
    case "list":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="card">
          <code>{block.text}</code>
        </pre>
      );
    case "step": {
      const done = view.completed[block.index];
      return (
        <div className={`step card row ${done ? "done" : ""}`}>
          <span aria-hidden="true">{done ? "✓" : "○"}</span>
          <span className="grow">{block.text}</span>
          {done ? (
            <span className="muted">
              {done.by} · {fmt(done.at)}
            </span>
          ) : view.incident.canWrite ? (
            <form action={completeStepAction}>
              <input type="hidden" name="incidentId" value={view.incident.id} />
              <input type="hidden" name="runbookId" value={view.runbook.id} />
              <input type="hidden" name="step" value={block.index} />
              <button type="submit">Mark done</button>
            </form>
          ) : null}
        </div>
      );
    }
  }
}

export default async function RunbookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; runbookId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id, runbookId }, { error }] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const view = await withUser(getPool(), user.id, (db) => getRunbookForIncident(db, id, runbookId));
  if (!view) notFound();

  const { blocks, steps } = parseRunbook(view.runbook.body);
  const doneCount = Object.keys(view.completed).length;

  return (
    <main className="stack">
      <p>
        <Link href={`/incidents/${view.incident.id}`}>← {view.incident.title}</Link>
      </p>
      <h1>{view.runbook.title}</h1>
      <p className="muted">
        {doneCount} of {steps.length} steps done{view.incident.canWrite ? "" : " · read-only"}
      </p>
      {error ? <p role="alert" className="error">{ERRORS[error] ?? "That change is not allowed."}</p> : null}
      {blocks.map((block, i) => (
        <RunbookBlock key={i} block={block} view={view} />
      ))}
    </main>
  );
}
