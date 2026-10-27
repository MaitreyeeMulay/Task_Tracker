// Usage: npm run migrate  (applies migrations/ to DATABASE_URL)
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrationFiles, runMigrations } from "../src/db/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set. See .env.example.");

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const applied = await runMigrations(client, await loadMigrationFiles(MIGRATIONS_DIR));
    console.log(JSON.stringify({ event: "migrations_applied", count: applied.length, versions: applied }));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Message only: pg errors here describe the SQL problem, not credentials.
  console.error(JSON.stringify({ event: "migrations_failed", message: (error as Error).message }));
  process.exit(1);
});
