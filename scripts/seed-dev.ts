// Usage: npm run seed  (development data in DATABASE_URL; safe to run twice)
// Refuses to run when NODE_ENV=production. The data lives in src/db/demo-data.ts.
import pg from "pg";
import { setPassword } from "../src/auth/login.ts";
import { DEMO_EMAILS, seedAdmin, seedCore, seedRunbooks } from "../src/db/demo-data.ts";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to seed in production");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set. See .env.example.");

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await seedCore(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    await seedRunbooks(client);
    await seedAdmin(client);
    await seedPasswords(client, connectionString);
  } finally {
    await client.end();
  }
}

// M5: give seeded users a password, if DEV_SEED_PASSWORD is set in .env.
// You choose the value, so no password lives in the code or is printed.
async function seedPasswords(client: pg.Client, connectionString: string): Promise<void> {
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password) {
    console.log(JSON.stringify({ event: "seed_passwords_skipped", reason: "DEV_SEED_PASSWORD not set" }));
    return;
  }
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE password_hash IS NULL
     AND lower(email) = ANY($1)`,
    [DEMO_EMAILS],
  );
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    for (const { id } of rows) {
      const result = await setPassword(pool, { userId: id, password });
      if (!result.ok) throw new Error(`DEV_SEED_PASSWORD rejected: ${result.error}`);
    }
  } finally {
    await pool.end();
  }
  console.log(JSON.stringify({ event: "seed_passwords_done", users: rows.length }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "seed_failed", message: (error as Error).message }));
  process.exit(1);
});
