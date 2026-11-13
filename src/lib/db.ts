import { Pool } from "pg";
import { poolConfigFromEnv } from "./aws.ts";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    // `next build` creates the pool while importing routes, with no database
    // configured. Then connecting fails at query time, as it always has.
    const configured = Boolean(process.env.DB_AUTH || process.env.DATABASE_URL);
    pool = new Pool({
      ...(configured ? poolConfigFromEnv(process.env) : {}),
      max: 10,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
    });
  }
  return pool;
}

// Returns false on any failure. Logs only the error code, never the
// message, because it can contain the host or user name.
export async function pingDb(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    console.error(JSON.stringify({ event: "db_ping_failed", code: typeof code === "string" ? code : "unknown" }));
    return false;
  }
}
