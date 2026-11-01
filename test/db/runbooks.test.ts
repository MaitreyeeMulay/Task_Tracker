import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { getIncident } from "../../src/incidents/repo.ts";
import { completeStep, getRunbookForIncident, listRunbooksForIncident } from "../../src/runbooks/repo.ts";
import { connect, dbError, inRollback } from "./helpers.ts";

// M3 "done when": a runbook opens from an incident and its steps are recorded on the timeline.

const INSUFFICIENT_PRIVILEGE = "42501";
const NOW = new Date("2026-11-01T12:00:00Z");
const BODY = "# Checkout 5xx\n\n- [ ] Check the dashboard\n- [ ] Roll back the deploy\n";
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function seed() {
  const { rows } = await client.query(
    `WITH tp AS (INSERT INTO teams (name) VALUES ('rb-payments') RETURNING id),
          ts AS (INSERT INTO teams (name) VALUES ('rb-search') RETURNING id),
          ua AS (INSERT INTO users (email, display_name) VALUES ('alice@rb.test', 'Alice') RETURNING id),
          ub AS (INSERT INTO users (email, display_name) VALUES ('bob@rb.test', 'Bob') RETURNING id),
          m AS (INSERT INTO memberships (team_id, user_id, role)
                SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
                UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'),
          sc AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM tp RETURNING id, team_id),
          sl AS (INSERT INTO services (team_id, name) SELECT id, 'ledger' FROM tp RETURNING id, team_id),
          ss AS (INSERT INTO services (team_id, name) SELECT id, 'search' FROM ts RETURNING id, team_id),
          rc AS (INSERT INTO runbooks (team_id, service_id, title, body_md) SELECT team_id, id, 'Checkout 5xx', $1 FROM sc RETURNING id),
          rl AS (INSERT INTO runbooks (team_id, service_id, title, body_md) SELECT team_id, id, 'Ledger disk', '- [ ] Free space' FROM sl RETURNING id),
          rs AS (INSERT INTO runbooks (team_id, service_id, title, body_md) SELECT team_id, id, 'Search down', '- [ ] Restart' FROM ss RETURNING id),
          ic AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'rb-c', 'SEV2', 'Checkout errors' FROM sc RETURNING id),
          isr AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) SELECT id, team_id, 'rb-s', 'SEV1', 'Search down' FROM ss RETURNING id)
     SELECT (SELECT id FROM ua) AS alice, (SELECT id FROM ub) AS bob,
            (SELECT id FROM rc) AS "checkoutRunbook", (SELECT id FROM rl) AS "ledgerRunbook", (SELECT id FROM rs) AS "searchRunbook",
            (SELECT id FROM ic) AS "checkoutIncident", (SELECT id FROM isr) AS "searchIncident"`,
    [BODY],
  );
  return rows[0] as Record<"alice" | "bob" | "checkoutRunbook" | "ledgerRunbook" | "searchRunbook" | "checkoutIncident" | "searchIncident", string>;
}

const alice = (w: { alice: string }) => ({ id: w.alice, name: "Alice" });

describe("runbooks on an incident", () => {
  it("lists only the runbooks for the incident's service", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await listRunbooksForIncident(client, w.checkoutIncident)).toEqual([
        { id: w.checkoutRunbook, title: "Checkout 5xx", stepCount: 2, doneCount: 0 },
      ]);
    });
  });

  it("opens a runbook from the incident, with its steps and nothing done yet", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const view = await getRunbookForIncident(client, w.checkoutIncident, w.checkoutRunbook);
      expect(view).toMatchObject({ runbook: { title: "Checkout 5xx", body: BODY }, incident: { title: "Checkout errors", canWrite: true }, completed: {} });
    });
  });

  it("does not open a runbook for a different service, or another team's", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await getRunbookForIncident(client, w.checkoutIncident, w.ledgerRunbook)).toBeNull();
      expect(await getRunbookForIncident(client, w.searchIncident, w.searchRunbook)).toBeNull();
    });
  });
});

describe("completing steps", () => {
  it("records a step with who and when, and puts it on the incident timeline", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await completeStep(client, { incidentId: w.checkoutIncident, runbookId: w.checkoutRunbook, stepIndex: 1, actor: alice(w), now: NOW })).toEqual({ ok: true });

      const view = await getRunbookForIncident(client, w.checkoutIncident, w.checkoutRunbook);
      expect(view?.completed).toEqual({ 1: { by: "Alice", at: expect.any(Date) } });
      expect((await listRunbooksForIncident(client, w.checkoutIncident))[0]?.doneCount).toBe(1);

      const timeline = (await getIncident(client, w.checkoutIncident))?.timeline ?? [];
      expect(timeline.at(-1)).toEqual({
        kind: "runbook_step",
        occurredAt: expect.any(Date),
        actorName: "Alice",
        detail: "Checkout 5xx: ✓ Roll back the deploy",
      });
    });
  });

  it("refuses to complete the same step twice", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const input = { incidentId: w.checkoutIncident, runbookId: w.checkoutRunbook, stepIndex: 0, actor: alice(w), now: NOW };
      await completeStep(client, input);
      expect(await completeStep(client, input)).toEqual({ ok: false, error: "already_done" });
    });
  });

  it("refuses a step that does not exist", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await completeStep(client, { incidentId: w.checkoutIncident, runbookId: w.checkoutRunbook, stepIndex: 5, actor: alice(w), now: NOW })).toEqual({
        ok: false,
        error: "invalid_step",
      });
    });
  });

  it("a Viewer is refused by the app and by the database", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect(
        await completeStep(client, { incidentId: w.checkoutIncident, runbookId: w.checkoutRunbook, stepIndex: 0, actor: { id: w.bob, name: "Bob" }, now: NOW }),
      ).toEqual({ ok: false, error: "forbidden" });
      const direct = await dbError(
        client,
        `INSERT INTO runbook_runs (runbook_id, incident_id, team_id, started_by)
         SELECT $1, $2, team_id, $3 FROM incidents WHERE id = $2`,
        [w.checkoutRunbook, w.checkoutIncident, w.bob],
      );
      expect(direct?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("another team's incident looks like it does not exist", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await completeStep(client, { incidentId: w.searchIncident, runbookId: w.searchRunbook, stepIndex: 0, actor: alice(w), now: NOW })).toEqual({
        ok: false,
        error: "not_found",
      });
    });
  });

  it("step completions are append-only", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await completeStep(client, { incidentId: w.checkoutIncident, runbookId: w.checkoutRunbook, stepIndex: 0, actor: alice(w), now: NOW });
      await client.query("RESET ROLE");
      expect((await dbError(client, "DELETE FROM runbook_step_completions"))?.message).toMatch(/append-only/);
    });
  });
});
