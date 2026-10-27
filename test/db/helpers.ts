import pg from "pg";
import { inject } from "vitest";

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: inject("testDatabaseUrl"), connectionTimeoutMillis: 5_000 });
  await client.connect();
  return client;
}

// Runs fn inside a transaction that is always rolled back, so tests leave no data.
export async function inRollback(client: pg.Client, fn: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await fn();
  } finally {
    await client.query("ROLLBACK");
  }
}

// Runs sql inside a savepoint and returns the Postgres error, or null if it succeeded.
export async function dbError(client: pg.Client, sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | null> {
  await client.query("SAVEPOINT expect_error");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT expect_error");
    return null;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT expect_error");
    const { code = "", message = "" } = error as { code?: string; message?: string };
    return { code, message };
  }
}
