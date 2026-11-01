import type { ClientBase, Pool, PoolClient } from "pg";

// Every user-facing query runs inside a transaction as app_rw, with the user's
// id in a transaction-local setting that the RLS policies read (app_user_id()).
// SET LOCAL / set_config(..., true) end with the transaction, so a pooled
// connection never carries one user's identity into another request.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Call inside an open transaction. */
export async function asUserInTransaction(db: ClientBase, userId: string): Promise<void> {
  if (!UUID.test(userId)) throw new Error("user id must be a UUID");
  await db.query("SET LOCAL ROLE app_rw");
  await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
}

/** Runs fn in its own transaction as the given user. Rolls back on error; never retries. */
export async function withUser<T>(pool: Pool, userId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await asUserInTransaction(client, userId);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}
