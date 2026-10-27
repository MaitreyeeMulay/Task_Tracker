import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientBase } from "pg";
import { checksum, parseMigrationFilename, planMigrations, type AppliedMigration, type MigrationFile } from "./migrations.ts";

// Arbitrary constant so two runners never apply migrations at the same time.
const MIGRATION_LOCK_ID = 7_301_001;

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for (const filename of await readdir(dir)) {
    if (!filename.endsWith(".sql")) continue;
    const parsed = parseMigrationFilename(filename);
    if (!parsed) throw new Error(`bad migration filename: ${filename} (expected NNNN_name.sql)`);
    const sql = await readFile(join(dir, filename), "utf8");
    files.push({ ...parsed, filename, sql, checksum: checksum(sql) });
  }
  return files;
}

// Each migration runs in its own transaction. A failure rolls that migration
// back and stops; it is never retried automatically.
export async function runMigrations(client: ClientBase, files: MigrationFile[]): Promise<number[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    const { rows } = await client.query<AppliedMigration>("SELECT version, checksum FROM schema_migrations");
    const pending = planMigrations(files, rows);
    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return pending.map((m) => m.version);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  }
}
