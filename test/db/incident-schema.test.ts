import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, dbError, inRollback } from "./helpers.ts";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const FP = "a".repeat(64);

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

// Seeds two teams with one service and one SNS integration each (as owner).
async function seed(): Promise<{ teamA: string; teamB: string; serviceA: string; serviceB: string; integrationA: string }> {
  const { rows } = await client.query(`
    WITH ta AS (INSERT INTO teams (name) VALUES ('team-a') RETURNING id),
         tb AS (INSERT INTO teams (name) VALUES ('team-b') RETURNING id),
         sa AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM ta RETURNING id, team_id),
         sb AS (INSERT INTO services (team_id, name) SELECT id, 'search' FROM tb RETURNING id, team_id),
         ia AS (INSERT INTO integrations (service_id, kind, sns_topic_arn)
                SELECT id, 'sns', 'arn:aws:sns:eu-west-2:123456789012:alerts' FROM sa RETURNING id)
    SELECT (SELECT id FROM ta) AS "teamA", (SELECT id FROM tb) AS "teamB",
           (SELECT id FROM sa) AS "serviceA", (SELECT id FROM sb) AS "serviceB",
           (SELECT id FROM ia) AS "integrationA"`);
  return rows[0];
}

async function openIncident(serviceId: string, teamId: string, fingerprint = FP): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) VALUES ($1, $2, $3, 'SEV2', 't') RETURNING id`,
    [serviceId, teamId, fingerprint],
  );
  return rows[0].id;
}

describe("incident dedupe is enforced by the database", () => {
  it("allows only one open incident per service and fingerprint", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      await openIncident(s.serviceA, s.teamA);
      const error = await dbError(
        client,
        `INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) VALUES ($1, $2, $3, 'SEV2', 'dup')`,
        [s.serviceA, s.teamA, FP],
      );
      expect(error?.code).toBe(UNIQUE_VIOLATION);
    });
  });

  it("allows a new incident once the previous one is resolved", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      const first = await openIncident(s.serviceA, s.teamA);
      await client.query(`UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = $1`, [first]);
      expect(await openIncident(s.serviceA, s.teamA)).not.toBe(first);
    });
  });

  it("allows the same fingerprint on a different service", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      await openIncident(s.serviceA, s.teamA);
      expect(await openIncident(s.serviceB, s.teamB)).toBeTruthy();
    });
  });

  it("stores each SNS delivery only once (same integration and MessageId)", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      const insert = `INSERT INTO alerts (integration_id, external_id, fingerprint, status, severity, title, payload)
                      VALUES ($1, 'msg-1', $2, 'firing', 'SEV2', 't', '{}')`;
      await client.query(insert, [s.integrationA, FP]);
      expect((await dbError(client, insert, [s.integrationA, FP]))?.code).toBe(UNIQUE_VIOLATION);
    });
  });
});

describe("data integrity", () => {
  it("rejects an incident whose team does not own the service", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      const error = await dbError(
        client,
        `INSERT INTO incidents (service_id, team_id, fingerprint, severity, title) VALUES ($1, $2, $3, 'SEV2', 't')`,
        [s.serviceA, s.teamB, FP],
      );
      expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  it.each([
    ["SNS integration without a topic", `INSERT INTO integrations (service_id, kind) VALUES ($1, 'sns')`],
    ["webhook integration without a secret reference", `INSERT INTO integrations (service_id, kind) VALUES ($1, 'webhook')`],
    ["unknown integration kind", `INSERT INTO integrations (service_id, kind, secret_ref) VALUES ($1, 'email', 'x')`],
  ])("rejects %s", async (_label, sql) => {
    await inRollback(client, async () => {
      const s = await seed();
      expect((await dbError(client, sql, [s.serviceA]))?.code).toBe(CHECK_VIOLATION);
    });
  });

  it.each([
    ["status", `UPDATE incidents SET status = 'paused'`],
    ["severity", `UPDATE incidents SET severity = 'SEV5'`],
  ])("rejects an invalid incident %s", async (_label, sql) => {
    await inRollback(client, async () => {
      const s = await seed();
      await openIncident(s.serviceA, s.teamA);
      expect((await dbError(client, sql))?.code).toBe(CHECK_VIOLATION);
    });
  });

  it("has no column that could hold a raw signing secret", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'integrations' ORDER BY column_name`,
    );
    const columns = rows.map((r) => r.column_name as string);
    expect(columns).toContain("secret_ref");
    expect(columns.filter((c) => /secret/.test(c) && c !== "secret_ref")).toEqual([]);
  });
});

describe("incident_events is append-only", () => {
  it("blocks update and delete, even for the owner", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      const incident = await openIncident(s.serviceA, s.teamA);
      await client.query(`INSERT INTO incident_events (incident_id, team_id, kind) VALUES ($1, $2, 'alert_received')`, [
        incident,
        s.teamA,
      ]);
      for (const sql of ["UPDATE incident_events SET kind = 'note'", "DELETE FROM incident_events"]) {
        expect((await dbError(client, sql))?.message, sql).toMatch(/incident_events is append-only/);
      }
    });
  });
});

describe("the ingest role", () => {
  it("is not a superuser, cannot bypass RLS and cannot log in", async () => {
    const { rows } = await client.query("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'app_ingest'");
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
  });

  it("can read integrations and write alerts, incidents and timeline events", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      await client.query("SET LOCAL ROLE app_ingest");
      const { rows } = await client.query("SELECT service_id FROM integrations WHERE id = $1", [s.integrationA]);
      expect(rows).toEqual([{ service_id: s.serviceA }]);
      expect(
        await dbError(
          client,
          `INSERT INTO alerts (integration_id, external_id, fingerprint, status, severity, title, payload)
           VALUES ($1, 'm', $2, 'firing', 'SEV2', 't', '{}')`,
          [s.integrationA, FP],
        ),
      ).toBeNull();
      expect(
        await dbError(
          client,
          `WITH i AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title)
                      VALUES ($1, $2, $3, 'SEV2', 't') RETURNING id, team_id)
           INSERT INTO incident_events (incident_id, team_id, kind) SELECT id, team_id, 'alert_received' FROM i`,
          [s.serviceA, s.teamA, FP],
        ),
      ).toBeNull();
    });
  });

  it.each([
    ["read users", "SELECT * FROM users"],
    ["read memberships", "SELECT * FROM memberships"],
    ["read the audit log", "SELECT * FROM audit_log"],
    ["create a team", "INSERT INTO teams (name) VALUES ('x')"],
    ["change an integration", "UPDATE integrations SET active = false"],
    ["delete an incident", "DELETE FROM incidents"],
  ])("cannot %s", async (_label, sql) => {
    await inRollback(client, async () => {
      await seed();
      await client.query("SET LOCAL ROLE app_ingest");
      expect((await dbError(client, sql))?.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("the app role sees no incident data until M2 adds team policies", () => {
  it("reads 0 rows from every new table", async () => {
    await inRollback(client, async () => {
      const s = await seed();
      const incident = await openIncident(s.serviceA, s.teamA);
      await client.query(`INSERT INTO incident_events (incident_id, team_id, kind) VALUES ($1, $2, 'note')`, [incident, s.teamA]);
      await client.query("SET LOCAL ROLE app_rw");
      for (const table of ["services", "integrations", "alerts", "incidents", "incident_events"]) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0], table).toEqual({ n: 0 });
      }
    });
  });
});
