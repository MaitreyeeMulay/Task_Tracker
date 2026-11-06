import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { getIncident, listIncidents, reopenIncident } from "../../src/incidents/repo.ts";
import { resolveIncident } from "../../src/incidents/resolve.ts";
import { completeStep, getChecklist, getChecklistRun } from "../../src/runbooks/repo.ts";
import { connect, inRollback } from "./helpers.ts";

const NOW = new Date("2026-11-07T12:00:00Z");
const LATER = new Date("2026-11-07T13:00:00Z");
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

type World = Record<"alice" | "bob" | "checklist" | "incident" | "other" | "theirs", string>;

async function seed(): Promise<World> {
  const { rows } = await client.query(
    `WITH tp AS (INSERT INTO teams (name) VALUES ('ro-payments') RETURNING id),
          ts AS (INSERT INTO teams (name) VALUES ('ro-search') RETURNING id),
          ua AS (INSERT INTO users (email, display_name) VALUES ('alice@ro.test', 'Alice') RETURNING id),
          ub AS (INSERT INTO users (email, display_name) VALUES ('bob@ro.test', 'Bob') RETURNING id),
          m AS (INSERT INTO memberships (team_id, user_id, role)
                SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
                UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'),
          sc AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM tp RETURNING id, team_id),
          ss AS (INSERT INTO services (team_id, name) SELECT id, 'search' FROM ts RETURNING id, team_id),
          rc AS (INSERT INTO runbooks (team_id, service_id, title, body_md) SELECT team_id, id, 'Checkout 5xx', '- [ ] Roll back' FROM sc RETURNING id, team_id),
          st AS (INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text) SELECT id, team_id, 1, 'Roll back' FROM rc),
          i1 AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'ro-fp', 'SEV2', 'Checkout errors' FROM sc RETURNING id),
          i2 AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'ro-fp-2', 'SEV3', 'Checkout slow' FROM sc RETURNING id),
          i3 AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'ro-s', 'SEV1', 'Search down' FROM ss RETURNING id)
     SELECT (SELECT id FROM ua) AS alice, (SELECT id FROM ub) AS bob, (SELECT id FROM rc) AS checklist,
            (SELECT id FROM i1) AS incident, (SELECT id FROM i2) AS other, (SELECT id FROM i3) AS theirs`,
  );
  return rows[0];
}

const alice = (w: World) => ({ id: w.alice, name: "Alice" });

describe("case numbers", () => {
  it("every incident gets a unique number from 1001 up", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      const { rows } = await client.query<{ number: string }>("SELECT number FROM incidents WHERE id = ANY($1) ORDER BY number", [[w.incident, w.other, w.theirs]]);
      const numbers = rows.map((r) => Number(r.number));
      expect(new Set(numbers).size).toBe(3);
      expect(Math.min(...numbers)).toBeGreaterThanOrEqual(1001);
    });
  });

  it("appear in the list and on the incident", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const incident = await getIncident(client, w.incident);
      expect(incident?.caseNumber).toMatch(/^INC-\d{4,}$/);
      const listed = (await listIncidents(client)).find((i) => i.id === w.incident);
      expect(listed?.caseNumber).toBe(incident?.caseNumber);
    });
  });

  it("can be used to open an incident, still limited to the user's teams", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await client.query("RESET ROLE");
      const theirs = (await client.query<{ number: string }>("SELECT number FROM incidents WHERE id = $1", [w.theirs])).rows[0]?.number;
      await asUserInTransaction(client, w.alice);
      const mine = (await getIncident(client, w.incident))?.caseNumber ?? "";
      expect((await getIncident(client, mine))?.id).toBe(w.incident);
      expect((await getIncident(client, mine.toLowerCase()))?.id).toBe(w.incident);
      expect(await getIncident(client, `INC-${theirs}`)).toBeNull();
    });
  });
});

describe("reopenIncident", () => {
  it("reopens as acknowledged with a reason; the old resolution is cleared and the step no longer counts as a fix", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const step = (await getChecklistRun(client, w.incident, w.checklist))?.steps[0]?.id ?? "";
      await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId: step, finding: "", actor: alice(w), now: NOW });
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "checklist_step", stepId: step } });
      expect((await getChecklist(client, w.checklist))?.steps[0]?.fixedCount).toBe(1);

      expect(await reopenIncident(client, { incidentId: w.incident, reason: "Errors came back after 20 minutes", actor: alice(w), now: LATER })).toEqual({ ok: true });

      const incident = await getIncident(client, w.incident);
      expect(incident).toMatchObject({ status: "acknowledged", resolutionKind: null, resolutionNote: null });
      expect(incident?.timeline.at(-1)).toMatchObject({
        kind: "status_changed",
        actorName: "Alice",
        detail: "resolved → acknowledged (reopened: Errors came back after 20 minutes)",
      });
      expect((await getChecklist(client, w.checklist))?.steps[0]?.fixedCount).toBe(0);
      await client.query("RESET ROLE");
      const row = (await client.query("SELECT resolved_at, acknowledged_at FROM incidents WHERE id = $1", [w.incident])).rows[0];
      expect(row).toEqual({ resolved_at: null, acknowledged_at: LATER });
    });
  });

  it("requires a reason", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "self_resolved", note: "" } });
      expect(await reopenIncident(client, { incidentId: w.incident, reason: "  ", actor: alice(w), now: LATER })).toEqual({ ok: false, error: "invalid_text" });
    });
  });

  it("only reopens resolved incidents", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await reopenIncident(client, { incidentId: w.incident, reason: "x", actor: alice(w), now: LATER })).toEqual({ ok: false, error: "not_resolved" });
    });
  });

  it("refuses when a newer open incident exists for the same alarm, and names it", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "self_resolved", note: "" } });
      await client.query("RESET ROLE");
      const newer = await client.query<{ number: string }>(
        `INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
         SELECT service_id, team_id, fingerprint, 'SEV2', 'Checkout errors again' FROM incidents WHERE id = $1 RETURNING number`,
        [w.incident],
      );
      await asUserInTransaction(client, w.alice);
      expect(await reopenIncident(client, { incidentId: w.incident, reason: "came back", actor: alice(w), now: LATER })).toEqual({
        ok: false,
        error: "duplicate_open",
        openCase: `INC-${newer.rows[0]?.number}`,
      });
      expect((await getIncident(client, w.incident))?.status).toBe("resolved");
    });
  });

  it("a Viewer cannot reopen", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "self_resolved", note: "" } });
      await asUserInTransaction(client, w.bob);
      expect(await reopenIncident(client, { incidentId: w.incident, reason: "x", actor: { id: w.bob, name: "Bob" }, now: LATER })).toEqual({
        ok: false,
        error: "forbidden",
      });
    });
  });

  it("checklist steps can be completed again after reopening", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await resolveIncident(client, { incidentId: w.incident, actor: alice(w), now: NOW, resolution: { kind: "self_resolved", note: "" } });
      await reopenIncident(client, { incidentId: w.incident, reason: "came back", actor: alice(w), now: LATER });
      const step = (await getChecklistRun(client, w.incident, w.checklist))?.steps[0]?.id ?? "";
      expect(await completeStep(client, { incidentId: w.incident, checklistId: w.checklist, stepId: step, finding: "", actor: alice(w), now: LATER })).toEqual({ ok: true });
    });
  });
});
