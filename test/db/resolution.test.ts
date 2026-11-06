import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { getIncident } from "../../src/incidents/repo.ts";
import { listCompletedSteps, resolveIncident } from "../../src/incidents/resolve.ts";
import { completeStep, getChecklist, getChecklistRun } from "../../src/runbooks/repo.ts";
import { connect, inRollback } from "./helpers.ts";

// Resolving asks "what resolved it?": a checklist step, something else
// (optionally proposed as a new step), or it recovered on its own.

const NOW = new Date("2026-11-06T12:00:00Z");
const BODY = "# Checkout\n\n- [ ] Check the dashboard\n- [ ] Roll back the deploy\n";
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

type World = Record<"alice" | "bob" | "checklist" | "incident", string>;

async function seed(): Promise<World> {
  const { rows } = await client.query(
    `WITH tp AS (INSERT INTO teams (name) VALUES ('res-payments') RETURNING id),
          ua AS (INSERT INTO users (email, display_name) VALUES ('alice@res.test', 'Alice') RETURNING id),
          ub AS (INSERT INTO users (email, display_name) VALUES ('bob@res.test', 'Bob') RETURNING id),
          m AS (INSERT INTO memberships (team_id, user_id, role)
                SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
                UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'),
          sc AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM tp RETURNING id, team_id),
          rc AS (INSERT INTO runbooks (team_id, service_id, title, body_md) SELECT team_id, id, 'Checkout 5xx', $1 FROM sc RETURNING id, team_id),
          st AS (INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text)
                 SELECT rc.id, rc.team_id, s.pos, s.text FROM rc, checklist_steps_from_markdown($1) s),
          ic AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'res-1', 'SEV2', 'Checkout errors' FROM sc RETURNING id)
     SELECT (SELECT id FROM ua) AS alice, (SELECT id FROM ub) AS bob, (SELECT id FROM rc) AS checklist, (SELECT id FROM ic) AS incident`,
    [BODY],
  );
  return rows[0];
}

const alice = (w: World) => ({ id: w.alice, name: "Alice" });

async function stepIds(w: World): Promise<string[]> {
  return ((await getChecklistRun(client, w.incident, w.checklist))?.steps ?? []).map((s) => s.id);
}

describe("checklist steps never resolve an incident", () => {
  it("completing every step leaves the incident open", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      for (const stepId of await stepIds(w)) {
        expect(await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId, finding: "", actor: alice(w), now: NOW })).toEqual({ ok: true });
      }
      const view = await getChecklistRun(client, w.incident, w.checklist);
      expect(view?.incident.status).toBe("triggered");
      expect(Object.keys(view?.completed ?? {})).toHaveLength(2);
    });
  });

  it("refuses to complete steps once the incident is resolved", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const [first] = await stepIds(w);
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "self_resolved", note: "" } });
      expect(await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId: first ?? "", finding: "", actor: alice(w), now: NOW })).toEqual({
        ok: false,
        error: "incident_resolved",
      });
    });
  });
});

describe("resolveIncident", () => {
  it("a completed checklist step fixed it: recorded, on the timeline, and counted on the step", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const [, rollback] = await stepIds(w);
      await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId: rollback ?? "", finding: "", actor: alice(w), now: NOW });
      expect(await listCompletedSteps(client, w.incident)).toEqual([{ stepId: rollback, text: "Roll back the deploy", checklistTitle: "Checkout 5xx" }]);

      expect(await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "checklist_step", stepId: rollback ?? "" } })).toEqual({
        ok: true,
      });
      const incident = await getIncident(client, w.incident);
      expect(incident).toMatchObject({ status: "resolved", resolutionKind: "checklist_step", resolutionNote: "Roll back the deploy" });
      expect(incident?.timeline.at(-1)?.detail).toBe('Resolved by checklist step "Roll back the deploy" (Checkout 5xx)');
      const steps = (await getChecklist(client, w.checklist))?.steps ?? [];
      expect(steps.map((s) => [s.text, s.fixedCount])).toEqual([
        ["Check the dashboard", 0],
        ["Roll back the deploy", 1],
      ]);
    });
  });

  it("refuses a step that was not completed on this incident", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const [dashboard] = await stepIds(w);
      expect(await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "checklist_step", stepId: dashboard ?? "" } })).toEqual({
        ok: false,
        error: "step_not_completed",
      });
      expect((await getIncident(client, w.incident))?.status).toBe("triggered");
    });
  });

  it("something else fixed it, proposed as a step for the checklist", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const result = await resolveIncident(client, {
        incidentId: w.incident,
        actor: alice(w),
        now: NOW,
        resolution: { kind: "other_fix", text: "Restarted the payment worker", proposeTo: w.checklist },
      });
      expect(result).toEqual({ ok: true });
      expect(await getIncident(client, w.incident)).toMatchObject({ resolutionKind: "other_fix", resolutionNote: "Restarted the payment worker" });
      expect((await getChecklistRun(client, w.incident, w.checklist))?.proposed.map((p) => p.text)).toEqual(["Restarted the payment worker"]);
    });
  });

  it("something else fixed it, without proposing anything", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "other_fix", text: "Provider fixed their outage" } });
      expect((await getChecklistRun(client, w.incident, w.checklist))?.proposed).toEqual([]);
      expect((await getIncident(client, w.incident))?.timeline.at(-1)?.detail).toBe("Resolved by something else: Provider fixed their outage");
    });
  });

  it("requires a description when something else fixed it", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "other_fix", text: "  " } })).toEqual({
        ok: false,
        error: "invalid_text",
      });
    });
  });

  it("it recovered on its own (note optional)", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "self_resolved", note: "" } })).toEqual({ ok: true });
      const incident = await getIncident(client, w.incident);
      expect(incident).toMatchObject({ status: "resolved", resolutionKind: "self_resolved", resolutionNote: null });
      expect(incident?.timeline.at(-1)?.detail).toBe("Resolved: recovered on its own / false alarm");
    });
  });

  it("a Viewer cannot resolve", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect(
        await resolveIncident(client, { incidentId: w.incident, actor: { id: w.bob, name: "Bob" }, now: NOW, resolution: { kind: "self_resolved", note: "" } }),
      ).toEqual({ ok: false, error: "forbidden" });
    });
  });
});
