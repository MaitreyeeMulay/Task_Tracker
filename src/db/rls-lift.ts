import type { ClientBase } from "pg";

// For the demo seed only. On RDS the database owner is not a superuser, so
// FORCE ROW LEVEL SECURITY (with no policies for the owner) blocks its inserts.
// This runs fn in ONE transaction with FORCE lifted from every table that has
// it, and puts it back before COMMIT. ALTER TABLE holds an ACCESS EXCLUSIVE
// lock until the transaction ends, so no other session can ever see a table
// without FORCE. Any error rolls back the lifting and the work together.

const FORCED_TABLES = `
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
  ORDER BY c.relname`;

export async function withForcedRlsLifted<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query<{ relname: string }>(FORCED_TABLES);
    const tables = rows.map((r) => client.escapeIdentifier(r.relname));
    for (const table of tables) await client.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
    const result = await fn();
    for (const table of tables) await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
