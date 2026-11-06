import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportAudit, listAudit } from "../../src/audit/repo.ts";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { connect, inRollback } from "./helpers.ts";

// M5: audit log and export. Admins read their own teams' audit trail; the
// export itself is written to the append-only audit log.

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function seed() {
  const { rows } = await client.query(`
    WITH ta AS (INSERT INTO teams (name) VALUES ('au-a') RETURNING id),
         tb AS (INSERT INTO teams (name) VALUES ('au-b') RETURNING id),
         adm AS (INSERT INTO users (email, display_name) VALUES ('adm@au.test', 'Adm') RETURNING id),
         rsp AS (INSERT INTO users (email, display_name) VALUES ('rsp@au.test', 'Rsp') RETURNING id),
         m AS (INSERT INTO memberships (team_id, user_id, role)
               SELECT (SELECT id FROM ta), (SELECT id FROM adm), 'admin'
               UNION ALL SELECT (SELECT id FROM ta), (SELECT id FROM rsp), 'responder'),
         a1 AS (INSERT INTO audit_log (team_id, action, entity_type, entity_id) SELECT id, 'incident.opened', 'incident', '=HYPERLINK("x")' FROM ta),
         a2 AS (INSERT INTO audit_log (team_id, action, entity_type, entity_id) SELECT id, 'incident.opened', 'incident', 'other-team' FROM tb)
    SELECT (SELECT id FROM adm) AS admin, (SELECT id FROM rsp) AS responder, (SELECT id FROM ta) AS "teamA"`);
  return rows[0] as { admin: string; responder: string; teamA: string };
}

describe("audit log access", () => {
  it("an admin sees only their own teams' entries", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.admin);
      const entries = await listAudit(client, { limit: 100 });
      expect(entries.map((e) => e.entityId)).toEqual(['=HYPERLINK("x")']);
      expect(entries[0]).toMatchObject({ action: "incident.opened", team: "au-a" });
    });
  });

  it("a responder sees nothing", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.responder);
      expect(await listAudit(client, { limit: 100 })).toEqual([]);
    });
  });
});

describe("audit export", () => {
  it("returns CSV of the admin's entries, neutralises formulas, and records the export itself", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.admin);
      const { csv, count } = await exportAudit(client, { actor: { id: w.admin, name: "Adm" }, now: new Date("2026-11-08T12:00:00Z") });
      expect(count).toBe(1);
      const lines = csv.trim().split("\r\n");
      expect(lines[0]).toBe("occurred_at,team,action,entity_type,entity_id,actor_user_id");
      expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
      expect(csv).not.toContain("other-team");

      await client.query("RESET ROLE");
      const recorded = await client.query("SELECT action, actor_user_id, entity_id FROM audit_log WHERE action = 'audit.exported' AND actor_user_id = $1", [w.admin]);
      expect(recorded.rows).toEqual([{ action: "audit.exported", actor_user_id: w.admin, entity_id: "1 rows" }]);
    });
  });

  it("a responder cannot export", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.responder);
      await expect(exportAudit(client, { actor: { id: w.responder, name: "Rsp" }, now: new Date() })).rejects.toThrow(/not an admin/);
    });
  });
});
