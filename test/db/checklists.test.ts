import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { changeStatus, getIncident } from "../../src/incidents/repo.ts";
import {
  addStep,
  completeStep,
  createChecklist,
  listWritableServices,
  getChecklist,
  getChecklistRun,
  listChecklistsForIncident,
  proposeStep,
  retireStep,
  reviewProposal,
  updateChecklist,
} from "../../src/runbooks/repo.ts";
import { connect, dbError, inRollback } from "./helpers.ts";

// Response checklists (internally: runbooks) as living documents:
// steps have stable ids and provenance, completions carry findings, and what
// fixed an incident can be proposed as a new step and reviewed.

const INSUFFICIENT_PRIVILEGE = "42501";
const NOW = new Date("2026-11-06T12:00:00Z");
const BODY = "# Checkout 5xx\n\nCustomers see errors at checkout.\n\n- [ ] Check the dashboard\n- [ ] Roll back the deploy\n";
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

type World = Record<"alice" | "bob" | "checklist" | "incident" | "otherIncident", string>;

// Seeds as owner; the checklist's steps are created the same way the migration backfills them.
async function seed(): Promise<World> {
  const { rows } = await client.query(
    `WITH tp AS (INSERT INTO teams (name) VALUES ('cl-payments') RETURNING id),
          ts AS (INSERT INTO teams (name) VALUES ('cl-search') RETURNING id),
          ua AS (INSERT INTO users (email, display_name) VALUES ('alice@cl.test', 'Alice') RETURNING id),
          ub AS (INSERT INTO users (email, display_name) VALUES ('bob@cl.test', 'Bob') RETURNING id),
          m AS (INSERT INTO memberships (team_id, user_id, role)
                SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
                UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'),
          sc AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM tp RETURNING id, team_id),
          ss AS (INSERT INTO services (team_id, name) SELECT id, 'search' FROM ts RETURNING id, team_id),
          rc AS (INSERT INTO runbooks (team_id, service_id, title, body_md) SELECT team_id, id, 'Checkout 5xx', $1 FROM sc RETURNING id, team_id),
          st AS (INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text)
                 SELECT rc.id, rc.team_id, s.pos, s.text FROM rc, checklist_steps_from_markdown($1) s),
          ic AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'cl-c', 'SEV2', 'Checkout errors' FROM sc RETURNING id),
          isr AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'cl-s', 'SEV1', 'Search down' FROM ss RETURNING id)
     SELECT (SELECT id FROM ua) AS alice, (SELECT id FROM ub) AS bob, (SELECT id FROM rc) AS checklist,
            (SELECT id FROM ic) AS incident, (SELECT id FROM isr) AS "otherIncident"`,
    [BODY],
  );
  return rows[0];
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const alice = (w: World) => ({ id: w.alice, name: "Alice" });
const bob = (w: World) => ({ id: w.bob, name: "Bob" });

async function run(w: World) {
  const view = await getChecklistRun(client, w.incident, w.checklist);
  if (!view) throw new Error("checklist run not found");
  return view;
}

describe("checklist_steps_from_markdown (used to backfill existing runbooks)", () => {
  it("extracts checklist lines in order", async () => {
    const { rows } = await client.query("SELECT pos, text FROM checklist_steps_from_markdown($1)", [
      "# T\r\n\r\nintro\r\n- [ ] one\r\n* [x] two\r\n- not a step\r\n-   [ ]   three  ",
    ]);
    expect(rows).toEqual([
      { pos: 1, text: "one" },
      { pos: 2, text: "two" },
      { pos: 3, text: "three" },
    ]);
  });
});

describe("opening a checklist from an incident", () => {
  it("shows the document and its steps with stable ids", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const view = await run(w);
      expect(view.checklist).toEqual({ id: w.checklist, title: "Checkout 5xx", body: BODY });
      expect(view.steps.map((s) => s.text)).toEqual(["Check the dashboard", "Roll back the deploy"]);
      expect(view.steps[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(view.incident.canWrite).toBe(true);
      expect(await listChecklistsForIncident(client, w.incident)).toEqual([
        { id: w.checklist, title: "Checkout 5xx", stepCount: 2, doneCount: 0, proposedCount: 0 },
      ]);
    });
  });

  it("is not available from another team's incident", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await getChecklistRun(client, w.otherIncident, w.checklist)).toBeNull();
    });
  });
});

describe("completing steps with findings", () => {
  it("records who, when and what they found, and shows it on the timeline", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const stepId = must((await run(w)).steps[0]).id;
      const input = { incidentId: w.incident, checklistId: w.checklist, stepId, finding: "Error rate 12%, started 09:10", actor: alice(w), now: NOW };
      expect(await completeStep(client, input)).toEqual({ ok: true });

      expect((await run(w)).completed[stepId]).toEqual({ by: "Alice", at: NOW, finding: "Error rate 12%, started 09:10" });
      const last = (await getIncident(client, w.incident))?.timeline.at(-1);
      expect(last).toMatchObject({ kind: "runbook_step", actorName: "Alice", detail: "Checkout 5xx: ✓ Check the dashboard — Error rate 12%, started 09:10" });
      expect(await completeStep(client, input)).toEqual({ ok: false, error: "already_done" });
    });
  });

  it("works without a finding", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const stepId = must((await run(w)).steps[1]).id;
      expect(await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId, finding: "  ", actor: alice(w), now: NOW })).toEqual({ ok: true });
      expect((await run(w)).completed[stepId]?.finding).toBeNull();
    });
  });

  it("a Viewer is refused by the app and by the database", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      const stepId = must((await run(w)).steps[0]).id;
      expect(await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId, finding: "", actor: bob(w), now: NOW })).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect((await dbError(client, "INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text) SELECT id, team_id, 9, 'x' FROM runbooks"))?.code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });
});

describe("learning from incidents", () => {
  it("resolving with 'what fixed it' stores it and adds it to the timeline", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const result = await changeStatus(client, { incidentId: w.incident, to: "resolved", actor: alice(w), now: NOW, resolutionNote: "Restarted the payment worker" });
      expect(result).toEqual({ ok: true });
      const incident = await getIncident(client, w.incident);
      expect(incident?.resolutionNote).toBe("Restarted the payment worker");
      expect(incident?.timeline.map((e) => e.detail)).toContain("What fixed it: Restarted the payment worker");
    });
  });

  it("a fix can be proposed as a step, linked to the incident, and accepted into the checklist", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await proposeStep(client, { incidentId: w.incident, checklistId: w.checklist, text: "Restart the payment worker", actor: alice(w) })).toEqual({ ok: true });

      const proposed = (await run(w)).proposed;
      expect(proposed).toEqual([
        { id: expect.any(String), text: "Restart the payment worker", sourceIncidentId: w.incident, sourceIncidentTitle: "Checkout errors", by: "Alice" },
      ]);
      expect((await run(w)).steps).toHaveLength(2);

      expect(await reviewProposal(client, { checklistId: w.checklist, stepId: must(proposed[0]).id, accept: true, actor: alice(w) })).toEqual({ ok: true });
      const steps = (await run(w)).steps;
      expect(steps.at(-1)).toEqual({
        id: must(proposed[0]).id,
        text: "Restart the payment worker",
        sourceIncidentId: w.incident,
        sourceIncidentTitle: "Checkout errors",
        addedBy: "Alice",
      });
      expect((await run(w)).proposed).toEqual([]);
    });
  });

  it("a rejected proposal never becomes a step", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await proposeStep(client, { incidentId: w.incident, checklistId: w.checklist, text: "Reboot everything", actor: alice(w) });
      const id = must((await run(w)).proposed[0]).id;
      expect(await reviewProposal(client, { checklistId: w.checklist, stepId: id, accept: false, actor: alice(w) })).toEqual({ ok: true });
      expect((await run(w)).steps.map((s) => s.text)).not.toContain("Reboot everything");
      expect((await run(w)).proposed).toEqual([]);
    });
  });

  it("a Viewer cannot propose or review", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect(await proposeStep(client, { incidentId: w.incident, checklistId: w.checklist, text: "x", actor: bob(w) })).toEqual({ ok: false, error: "forbidden" });
    });
  });

  it("refuses empty or oversized proposals", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      for (const text of ["", "   ", "x".repeat(1001)]) {
        expect(await proposeStep(client, { incidentId: w.incident, checklistId: w.checklist, text, actor: alice(w) })).toEqual({ ok: false, error: "invalid_text" });
      }
    });
  });
});

describe("editing a checklist", () => {
  it("updates the document text and adds steps at the end", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await updateChecklist(client, { checklistId: w.checklist, title: "Checkout errors", body: "# Checkout\n\nNew intro.", actor: alice(w) })).toEqual({ ok: true });
      expect(await addStep(client, { checklistId: w.checklist, text: "Page the payments lead", actor: alice(w) })).toEqual({ ok: true });
      const checklist = await getChecklist(client, w.checklist);
      expect(checklist).toMatchObject({ title: "Checkout errors", body: "# Checkout\n\nNew intro.", canWrite: true });
      expect(checklist?.steps.map((s) => s.text)).toEqual(["Check the dashboard", "Roll back the deploy", "Page the payments lead"]);
    });
  });

  it("retiring a step hides it but keeps earlier completions intact", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const [first] = (await run(w)).steps;
      await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId: must(first).id, finding: "ok", actor: alice(w), now: NOW });
      expect(await retireStep(client, { checklistId: w.checklist, stepId: must(first).id, actor: alice(w) })).toEqual({ ok: true });

      expect((await run(w)).steps.map((s) => s.text)).toEqual(["Roll back the deploy"]);
      expect((await getChecklist(client, w.checklist))?.retired.map((s) => s.text)).toEqual(["Check the dashboard"]);
      const timeline = (await getIncident(client, w.incident))?.timeline ?? [];
      expect(timeline.some((e) => e.detail?.includes("Check the dashboard"))).toBe(true);
    });
  });

  it("a Responder can create a checklist for a service of their team; steps come from its '- [ ]' lines", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const services = await listWritableServices(client);
      expect(services.map((s) => s.name)).toEqual(["checkout"]);
      const created = await createChecklist(client, {
        serviceId: must(services[0]).id,
        title: "Checkout slow",
        body: "Latency above 2s.\n\n- [ ] Check the database\n- [ ] Scale out",
        actor: alice(w),
      });
      expect(created).toEqual({ ok: true, id: expect.any(String) });
      const doc = await getChecklist(client, (created as { id: string }).id);
      expect(doc?.steps.map((s) => s.text)).toEqual(["Check the database", "Scale out"]);
      expect(doc?.steps[0]?.addedBy).toBe("Alice");
    });
  });

  it("a Viewer sees no services to create a checklist for", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect(await listWritableServices(client)).toEqual([]);
    });
  });

  it("a Viewer cannot edit", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect(await updateChecklist(client, { checklistId: w.checklist, title: "x", body: "y", actor: bob(w) })).toEqual({ ok: false, error: "forbidden" });
      expect(await addStep(client, { checklistId: w.checklist, text: "x", actor: bob(w) })).toEqual({ ok: false, error: "forbidden" });
      expect((await getChecklist(client, w.checklist))?.canWrite).toBe(false);
    });
  });
});
