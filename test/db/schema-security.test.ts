import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, dbError, inRollback } from "./helpers.ts";

const TEAM_TABLES = ["teams", "users", "memberships", "audit_log"];
const INSUFFICIENT_PRIVILEGE = "42501";

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

// Seeds one row per table as the owner, then switches to the app role.
async function seedThenActAsApp(): Promise<void> {
  await client.query(`
    WITH t AS (INSERT INTO teams (name) VALUES ('payments') RETURNING id),
         u AS (INSERT INTO users (email, display_name) VALUES ('a@example.test', 'A') RETURNING id)
    INSERT INTO memberships (team_id, user_id) SELECT t.id, u.id FROM t, u`);
  await client.query(`INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('seed', 'team', 'x')`);
  await client.query("SET LOCAL ROLE app_rw");
}

describe("the app role", () => {
  it("is not a superuser and cannot bypass row-level security", async () => {
    const { rows } = await client.query("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'app_rw'");
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
  });

  it("does not own any table, so row-level security always applies to it", async () => {
    const { rows } = await client.query(
      "SELECT relname FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'app_rw')",
    );
    expect(rows).toEqual([]);
  });
});

describe("row-level security", () => {
  it("is enabled and forced on every table except schema_migrations", async () => {
    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      ORDER BY c.relname`);
    expect(rows.map((r) => r.relname)).toEqual(expect.arrayContaining(TEAM_TABLES));
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("is closed by default: with no user context the app role reads 0 rows", async () => {
    await inRollback(client, async () => {
      await seedThenActAsApp();
      for (const table of ["teams", "users", "memberships"]) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0], table).toEqual({ n: 0 });
      }
    });
  });

  it("is closed by default: the app role cannot insert a team", async () => {
    await inRollback(client, async () => {
      await client.query("SET LOCAL ROLE app_rw");
      const error = await dbError(client, "INSERT INTO teams (name) VALUES ('sneaky')");
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(error?.message).toMatch(/row-level security/);
    });
  });
});

describe("audit_log is append-only", () => {
  it("lets the app role insert", async () => {
    await inRollback(client, async () => {
      await client.query("SET LOCAL ROLE app_rw");
      expect(await dbError(client, "INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('test', 'team', '1')")).toBeNull();
    });
  });

  it("does not let the app role read, update or delete", async () => {
    await inRollback(client, async () => {
      await seedThenActAsApp();
      for (const sql of ["SELECT * FROM audit_log", "UPDATE audit_log SET action = 'x'", "DELETE FROM audit_log"]) {
        expect((await dbError(client, sql))?.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });

  it("blocks update, delete and truncate even for the owner", async () => {
    await inRollback(client, async () => {
      await client.query(`INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('seed', 'team', 'x')`);
      for (const sql of ["UPDATE audit_log SET action = 'x'", "DELETE FROM audit_log", "TRUNCATE audit_log"]) {
        expect((await dbError(client, sql))?.message, sql).toMatch(/audit_log is append-only/);
      }
    });
  });
});

describe("migrations", () => {
  it("are recorded with checksums", async () => {
    const { rows } = await client.query("SELECT version, length(checksum) AS len FROM schema_migrations ORDER BY version");
    expect(rows[0]).toEqual({ version: 1, len: 64 });
  });
});
