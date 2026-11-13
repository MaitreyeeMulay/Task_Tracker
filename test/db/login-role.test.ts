import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, dbError, inRollback } from "./helpers.ts";

// tracker_app is the login role the app and worker use on AWS (IAM auth).
// It holds no privileges itself: it can only switch into the narrow app roles.

const APP_ROLES = ["app_rw", "app_ingest", "app_worker", "app_auth"];
const INSUFFICIENT_PRIVILEGE = "42501";

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

describe("the tracker_app login role", () => {
  it("can log in but is not a superuser, cannot bypass RLS and cannot create roles or databases", async () => {
    const { rows } = await client.query(
      "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = 'tracker_app'",
    );
    expect(rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, no_password: true }]);
  });

  it.each(APP_ROLES)("can switch to %s", async (role) => {
    await inRollback(client, async () => {
      await client.query("SET LOCAL ROLE tracker_app");
      expect(await dbError(client, `SET LOCAL ROLE ${role}`)).toBeNull();
    });
  });

  it("does not inherit the app roles' privileges, so every query must pick a role first", async () => {
    await inRollback(client, async () => {
      await client.query("SET LOCAL ROLE tracker_app");
      expect((await dbError(client, "SELECT 1 FROM incidents LIMIT 1"))?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("owns nothing", async () => {
    const { rows } = await client.query("SELECT relname FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'tracker_app')");
    expect(rows).toEqual([]);
  });
});
