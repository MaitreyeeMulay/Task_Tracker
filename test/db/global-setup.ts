import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { loadMigrationFiles, runMigrations } from "../../src/db/migrate.ts";
import { testDatabaseUrl } from "../../src/db/migrations.ts";

declare module "vitest" {
  interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

// Connects to the *_test database, fails fast if Postgres is not running,
// and brings the schema up to date before any test runs.
export default async function setup(project: TestProject): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env: rely on the environment (CI sets TEST_DATABASE_URL).
  }
  const url = testDatabaseUrl(process.env);

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    throw new Error(`Cannot reach the test database (${code}). Start it with: docker compose up -d db`);
  }
  try {
    await runMigrations(client, await loadMigrationFiles(MIGRATIONS_DIR));
  } finally {
    await client.end();
  }
  project.provide("testDatabaseUrl", url);
}
