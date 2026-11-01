import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { connect, dbError, inRollback } from "./helpers.ts";

// M2 "done when": a Responder sees only their teams' incidents, and a Viewer cannot write.
// Enforced by row-level security on the app_rw role, not by application code.

const INSUFFICIENT_PRIVILEGE = "42501";
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

interface World {
  alice: string; // responder, payments
  bob: string; // viewer, payments
  carol: string; // responder, search
  payments: string;
  search: string;
  paymentsIncident: string;
  searchIncident: string;
}

async function seed(): Promise<World> {
  const { rows } = await client.query(`
    WITH tp AS (INSERT INTO teams (name) VALUES ('scope-payments') RETURNING id),
         ts AS (INSERT INTO teams (name) VALUES ('scope-search') RETURNING id),
         ua AS (INSERT INTO users (email, display_name) VALUES ('alice@scope.test', 'Alice') RETURNING id),
         ub AS (INSERT INTO users (email, display_name) VALUES ('bob@scope.test', 'Bob') RETURNING id),
         uc AS (INSERT INTO users (email, display_name) VALUES ('carol@scope.test', 'Carol') RETURNING id),
         m AS (INSERT INTO memberships (team_id, user_id, role)
               SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
               UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'
               UNION ALL SELECT (SELECT id FROM ts), (SELECT id FROM uc), 'responder'),
         sp AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM tp RETURNING id, team_id),
         ss AS (INSERT INTO services (team_id, name) SELECT id, 'search-api' FROM ts RETURNING id, team_id),
         ip AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
                SELECT id, team_id, 'fp-p', 'SEV2', 'Checkout errors' FROM sp RETURNING id),
         isr AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
                SELECT id, team_id, 'fp-s', 'SEV3', 'Search slow' FROM ss RETURNING id)
    SELECT (SELECT id FROM ua) AS alice, (SELECT id FROM ub) AS bob, (SELECT id FROM uc) AS carol,
           (SELECT id FROM tp) AS payments, (SELECT id FROM ts) AS search,
           (SELECT id FROM ip) AS "paymentsIncident", (SELECT id FROM isr) AS "searchIncident"`);
  return rows[0];
}

async function asUser(userId: string): Promise<void> {
  await asUserInTransaction(client, userId);
}

describe("team scoping (reads)", () => {
  it("a Responder sees only their own teams' incidents", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      const { rows } = await client.query("SELECT id FROM incidents");
      expect(rows).toEqual([{ id: w.paymentsIncident }]);
    });
  });

  it("another team's Responder sees only theirs", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.carol);
      const { rows } = await client.query("SELECT id FROM incidents");
      expect(rows).toEqual([{ id: w.searchIncident }]);
    });
  });

  it("a Viewer can read their team's incidents", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.bob);
      expect((await client.query("SELECT id FROM incidents")).rows).toEqual([{ id: w.paymentsIncident }]);
    });
  });

  it("users see only their own teams and their own memberships", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      expect((await client.query("SELECT id FROM teams")).rows).toEqual([{ id: w.payments }]);
      expect((await client.query("SELECT user_id, role FROM memberships")).rows).toEqual([{ user_id: w.alice, role: "responder" }]);
    });
  });

  it("users can read their own profile but not other people's", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      expect((await client.query("SELECT display_name FROM users")).rows).toEqual([{ display_name: "Alice" }]);
    });
  });

  it("guessing another team's incident id returns nothing", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      expect((await client.query("SELECT id FROM incidents WHERE id = $1", [w.searchIncident])).rows).toEqual([]);
    });
  });
});

describe("team scoping (writes)", () => {
  it("a Responder can change their team's incident", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      const result = await client.query("UPDATE incidents SET status = 'acknowledged' WHERE id = $1", [w.paymentsIncident]);
      expect(result.rowCount).toBe(1);
    });
  });

  it("a Responder cannot change another team's incident", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      const result = await client.query("UPDATE incidents SET status = 'resolved' WHERE id = $1", [w.searchIncident]);
      expect(result.rowCount).toBe(0);
    });
  });

  it("a Viewer cannot change an incident", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.bob);
      const result = await client.query("UPDATE incidents SET status = 'resolved' WHERE id = $1", [w.paymentsIncident]);
      expect(result.rowCount).toBe(0);
    });
  });

  it("a Viewer cannot add to the timeline", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.bob);
      const error = await dbError(
        client,
        `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id) VALUES ($1, $2, 'note', $3)`,
        [w.paymentsIncident, w.payments, w.bob],
      );
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("a Responder can add to the timeline as themselves, but not as someone else", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      const insert = `INSERT INTO incident_events (incident_id, team_id, kind, actor_user_id) VALUES ($1, $2, 'status_changed', $3)`;
      expect(await dbError(client, insert, [w.paymentsIncident, w.payments, w.alice])).toBeNull();
      expect((await dbError(client, insert, [w.paymentsIncident, w.payments, w.bob]))?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("audit rows must name the acting user", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUser(w.alice);
      const insert = `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, 'x', 'incident', '1')`;
      expect(await dbError(client, insert, [w.alice, w.payments])).toBeNull();
      expect((await dbError(client, insert, [w.bob, w.payments]))?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("asUserInTransaction", () => {
  it("rejects a non-UUID user id before touching the database", async () => {
    await inRollback(client, async () => {
      await expect(asUserInTransaction(client, "1; DROP TABLE users")).rejects.toThrow(/user id/);
    });
  });
});
