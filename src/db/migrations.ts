import { createHash } from "node:crypto";

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  checksum: string;
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigrationFilename(filename: string): { version: number; name: string } | null {
  const match = FILENAME.exec(filename);
  if (!match?.[1] || !match[2]) return null;
  return { version: Number(match[1]), name: match[2] };
}

// Line endings are normalised so a checkout on Windows gives the same checksum.
export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

// Decides which migrations to run. Refuses anything that would leave the
// schema in a state the files do not describe.
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationFile[] {
  const byVersion = new Map<number, MigrationFile>();
  for (const file of files) {
    if (byVersion.has(file.version)) throw new Error(`duplicate migration version ${file.version}`);
    byVersion.set(file.version, file);
  }

  const appliedVersions = new Set<number>();
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) throw new Error(`migration ${row.version} was applied but its file is missing`);
    if (file.checksum !== row.checksum) throw new Error(`migration ${row.version} was changed after it was applied`);
    appliedVersions.add(row.version);
  }

  const latestApplied = Math.max(0, ...appliedVersions);
  const pending = [...byVersion.values()].filter((f) => !appliedVersions.has(f.version)).sort((a, b) => a.version - b.version);
  const stale = pending.find((f) => f.version < latestApplied);
  if (stale) throw new Error(`migration ${stale.version} is older than applied migration ${latestApplied}`);
  return pending;
}

// Database tests delete data, so they only ever run against a *_test database.
export function testDatabaseUrl(env: Record<string, string | undefined>): string {
  let url: URL;
  if (env.TEST_DATABASE_URL) {
    url = new URL(env.TEST_DATABASE_URL);
  } else if (env.DATABASE_URL) {
    url = new URL(env.DATABASE_URL);
    url.pathname = `${url.pathname}_test`;
  } else {
    throw new Error("Set DATABASE_URL (or TEST_DATABASE_URL) in .env. See .env.example.");
  }
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run database tests: database name "${dbName}" must end in _test`);
  }
  return url.toString();
}
