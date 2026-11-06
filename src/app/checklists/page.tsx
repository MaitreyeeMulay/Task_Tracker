import Link from "next/link";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { listChecklists, listWritableServices } from "@/runbooks/repo";
import { createChecklistAction } from "./actions";

export const dynamic = "force-dynamic";

const TEMPLATE = `# What this checklist is for

When to use it and what "fixed" looks like.

- [ ] First thing to check
- [ ] Next step
`;

export default async function ChecklistsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await requireUser();
  const { checklists, services } = await withUser(getPool(), user.id, async (db) => ({
    checklists: await listChecklists(db),
    services: await listWritableServices(db),
  }));

  return (
    <main className="stack">
      <h1>Response checklists</h1>
      <p className="muted">
        Living documents your team follows during incidents. Steps that helped in past incidents are linked to them; fixes found
        during an incident can be proposed as new steps.
      </p>
      {checklists.length === 0 ? (
        <p className="muted">No checklists for your teams yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Checklist</th>
              <th>Service</th>
              <th>Steps</th>
              <th>Proposed</th>
            </tr>
          </thead>
          <tbody>
            {checklists.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/checklists/${c.id}`}>{c.title}</Link>
                </td>
                <td>{c.service}</td>
                <td>{c.stepCount}</td>
                <td>{c.proposedCount || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {services.length > 0 ? (
        <>
          <h2>New checklist</h2>
          {error ? <p role="alert" className="error">Could not create the checklist ({error}).</p> : null}
          <form action={createChecklistAction} className="card stack">
            <label className="stack">
              <span>Service</span>
              <select name="serviceId" required>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span>Title</span>
              <input name="title" required maxLength={200} placeholder="e.g. Checkout slow" />
            </label>
            <label className="stack">
              <span>Document (Markdown; each &quot;- [ ]&quot; line becomes a step)</span>
              <textarea name="body" required rows={10} maxLength={20000} defaultValue={TEMPLATE} />
            </label>
            <div>
              <button type="submit">Create checklist</button>
            </div>
          </form>
        </>
      ) : null}
    </main>
  );
}
