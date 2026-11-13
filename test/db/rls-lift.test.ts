import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withForcedRlsLifted } from "../../src/db/rls-lift.ts";
import { connect } from "./helpers.ts";

// The demo seed runs as the database owner, which on RDS is not a superuser,
// so forced row-level security would block its inserts. This helper lifts it
// for one transaction and must always put it back.

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function forcedTables(): Promise<string[]> {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity ORDER BY 1`,
  );
  return rows.map((r) => r.relname);
}

describe("withForcedRlsLifted", () => {
  it("lifts forced RLS inside the transaction, restores it on commit and keeps the work", async () => {
    const before = await forcedTables();
    expect(before).toContain("teams");

    let inside: string[] = [];
    await withForcedRlsLifted(client, async () => {
      inside = await forcedTables();
      await client.query("INSERT INTO teams (name) VALUES ('rls-lift-commit')");
    });

    expect(inside).toEqual([]);
    expect(await forcedTables()).toEqual(before);
    const { rowCount } = await client.query("SELECT 1 FROM teams WHERE name = 'rls-lift-commit'");
    expect(rowCount).toBe(1);
    await client.query("DELETE FROM teams WHERE name = 'rls-lift-commit'");
  });

  it("rolls everything back on error, so RLS is never left lifted", async () => {
    const before = await forcedTables();

    await expect(
      withForcedRlsLifted(client, async () => {
        await client.query("INSERT INTO teams (name) VALUES ('rls-lift-rollback')");
        throw new Error("seed failed");
      }),
    ).rejects.toThrow("seed failed");

    expect(await forcedTables()).toEqual(before);
    const { rowCount } = await client.query("SELECT 1 FROM teams WHERE name = 'rls-lift-rollback'");
    expect(rowCount).toBe(0);
  });
});
