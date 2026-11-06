import Link from "next/link";
import { parseRunbook, type Block } from "@/runbooks/markdown";
import type { ChecklistStep } from "@/runbooks/repo";

// Shared pieces for response checklists. Everything renders as React text:
// checklist content can never become HTML.

function ProseBlock({ block }: { block: Block }) {
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
    case "step":
      return null; // steps live in checklist_steps, not in the text
  }
}

/** The document part of a checklist (headings, notes, commands). */
export function ChecklistProse({ body }: { body: string }) {
  return (
    <>
      {parseRunbook(body).blocks.map((block, i) => (
        <ProseBlock key={i} block={block} />
      ))}
    </>
  );
}

/** "Fixed 3 incidents" — how often this step was what resolved an incident. */
export function FixedCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="badge">fixed {count} incident{count === 1 ? "" : "s"}</span>;
}

/** "Added from incident X by Alice" — where a step came from. */
export function Provenance({ step }: { step: Pick<ChecklistStep, "sourceIncidentId" | "sourceIncidentTitle" | "sourceCaseNumber" | "addedBy"> }) {
  if (!step.sourceIncidentId && !step.addedBy) return null;
  return (
    <span className="muted small">
      {step.sourceIncidentId ? (
        <>
          learned from <Link href={`/incidents/${step.sourceIncidentId}`}>{step.sourceCaseNumber ?? "an incident"}</Link>
          {step.sourceIncidentTitle ? ` (${step.sourceIncidentTitle})` : ""}
        </>
      ) : (
        "added"
      )}
      {step.addedBy ? ` by ${step.addedBy}` : ""}
    </span>
  );
}
