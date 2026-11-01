import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { changeStatus, getIncident, listIncidents } from "../../src/incidents/repo.ts";
import { connect, inRollback } from "./helpers.ts";

let client: pg.Client;
const NOW = new Date("2026-11-01T12:00:00Z");

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function seed() {
  const { rows } = await client.query(`
    WITH tp AS (INSERT INTO teams (name) VALUES ('repo-payments') RETURNING id),
         ts AS (INSERT INTO teams (name) VALUES ('repo-search') RETURNING id),
         ua AS (INSERT INTO users (email, display_name) VALUES ('alice@repo.test', 'Alice') RETURNING id),
         ub AS (INSERT INTO users (email, display_name) VALUES ('bob@repo.test', 'Bob') RETURNING id),
         m AS (INSERT INTO memberships (team_id, user_id, role)
               SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
               UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'),
         sp AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM tp RETURNING id, team_id),
         ss AS (INSERT INTO services (team_id, name) SELECT id, 'search-api' FROM ts RETURNING id, team_id),
         ip AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
                SELECT id, team_id, 'fp-p', 'SEV2', 'Checkout errors' FROM sp RETURNING id, team_id),
         ev AS (INSERT INTO incident_events (incident_id, team_id, kind) SELECT id, team_id, 'alert_received' FROM ip),
         isr AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
                 SELECT id, team_id, 'fp-s', 'SEV3', 'Search slow' FROM ss RETURNING id)
    SELECT (SELECT id FROM ua) AS alice, (SELECT id FROM ub) AS bob,
           (SELECT id FROM ip) AS mine, (SELECT id FROM isr) AS theirs`);
  return rows[0] as { alice: string; bob: string; mine: string; theirs: string };
}

const actor = (id: string, name: string) => ({ id, name });

describe("listIncidents", () => {
  it("lists only the user's teams' incidents, with service and my role", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await listIncidents(client)).toEqual([
        {
          id: w.mine,
          title: "Checkout errors",
          severity: "SEV2",
          status: "triggered",
          service: "checkout",
          alertCount: 1,
          openedAt: expect.any(Date),
        },
      ]);
    });
  });
});

describe("getIncident", () => {
  it("returns the incident, its timeline and whether the user may change it", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      const incident = await getIncident(client, w.mine);
      expect(incident).toMatchObject({ id: w.mine, title: "Checkout errors", status: "triggered", canWrite: true });
      expect(incident?.timeline).toEqual([{ kind: "alert_received", occurredAt: expect.any(Date), actorName: null, detail: null }]);
    });
  });

  it("says a Viewer may not change it", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect((await getIncident(client, w.mine))?.canWrite).toBe(false);
    });
  });

  it("returns null for another team's incident or a bad id", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await getIncident(client, w.theirs)).toBeNull();
      expect(await getIncident(client, "not-a-uuid")).toBeNull();
    });
  });
});

describe("changeStatus", () => {
  it("a Responder acknowledges: status, timestamp, timeline entry and audit row", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await changeStatus(client, { incidentId: w.mine, to: "acknowledged", actor: actor(w.alice, "Alice"), now: NOW })).toEqual({ ok: true });

      const incident = await getIncident(client, w.mine);
      expect(incident?.status).toBe("acknowledged");
      expect(incident?.timeline.at(-1)).toEqual({
        kind: "status_changed",
        occurredAt: expect.any(Date),
        actorName: "Alice",
        detail: "triggered → acknowledged",
      });
      await client.query("RESET ROLE");
      const audit = await client.query("SELECT action, actor_user_id FROM audit_log WHERE entity_id = $1", [w.mine]);
      expect(audit.rows).toEqual([{ action: "incident.status_changed", actor_user_id: w.alice }]);
      const ts = await client.query("SELECT acknowledged_at FROM incidents WHERE id = $1", [w.mine]);
      expect(ts.rows[0].acknowledged_at).toEqual(NOW);
    });
  });

  it("a Viewer is refused and nothing changes", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.bob);
      expect(await changeStatus(client, { incidentId: w.mine, to: "resolved", actor: actor(w.bob, "Bob"), now: NOW })).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect((await getIncident(client, w.mine))?.status).toBe("triggered");
    });
  });

  it("an invalid move is refused", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      await changeStatus(client, { incidentId: w.mine, to: "resolved", actor: actor(w.alice, "Alice"), now: NOW });
      expect(await changeStatus(client, { incidentId: w.mine, to: "acknowledged", actor: actor(w.alice, "Alice"), now: NOW })).toEqual({
        ok: false,
        error: "cannot move from resolved to acknowledged",
      });
    });
  });

  it("another team's incident looks like it does not exist", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.alice);
      expect(await changeStatus(client, { incidentId: w.theirs, to: "resolved", actor: actor(w.alice, "Alice"), now: NOW })).toEqual({
        ok: false,
        error: "not_found",
      });
    });
  });
});
