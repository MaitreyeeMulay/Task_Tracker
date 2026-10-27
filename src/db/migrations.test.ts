import { describe, expect, it } from "vitest";
import {
  checksum,
  parseMigrationFilename,
  planMigrations,
  testDatabaseUrl,
  type MigrationFile,
} from "./migrations.ts";

function file(version: number, sql = `-- ${version}`): MigrationFile {
  const name = `m${version}`;
  return { version, name, filename: `${String(version).padStart(4, "0")}_${name}.sql`, sql, checksum: checksum(sql) };
}

describe("parseMigrationFilename", () => {
  it("parses NNNN_name.sql", () => {
    expect(parseMigrationFilename("0001_init.sql")).toEqual({ version: 1, name: "init" });
  });

  it.each(["init.sql", "1_init.sql", "0001_Init.sql", "0001_init.SQL", "0001_init.sql.bak", "0001-init.sql"])(
    "rejects %s",
    (name) => {
      expect(parseMigrationFilename(name)).toBeNull();
    },
  );
});

describe("checksum", () => {
  it("ignores CRLF versus LF line endings", () => {
    expect(checksum("a\r\nb\r\n")).toBe(checksum("a\nb\n"));
  });

  it("changes when the content changes", () => {
    expect(checksum("select 1")).not.toBe(checksum("select 2"));
  });
});

describe("planMigrations", () => {
  it("returns all files in version order when nothing is applied", () => {
    expect(planMigrations([file(2), file(1)], []).map((m) => m.version)).toEqual([1, 2]);
  });

  it("skips applied migrations", () => {
    const one = file(1);
    expect(planMigrations([one, file(2)], [{ version: 1, checksum: one.checksum }]).map((m) => m.version)).toEqual([2]);
  });

  it("returns nothing when everything is applied", () => {
    const one = file(1);
    expect(planMigrations([one], [{ version: 1, checksum: one.checksum }])).toEqual([]);
  });

  it("rejects duplicate versions", () => {
    expect(() => planMigrations([file(1, "a"), file(1, "b")], [])).toThrow(/duplicate migration version 1/);
  });

  it("rejects an applied migration whose file is missing", () => {
    expect(() => planMigrations([], [{ version: 1, checksum: "x" }])).toThrow(/migration 1 was applied but its file is missing/);
  });

  it("rejects an applied migration that was edited afterwards", () => {
    expect(() => planMigrations([file(1, "changed")], [{ version: 1, checksum: checksum("original") }])).toThrow(
      /migration 1 was changed after it was applied/,
    );
  });

  it("rejects a new migration older than the latest applied one", () => {
    const two = file(2);
    expect(() => planMigrations([file(1), two], [{ version: 2, checksum: two.checksum }])).toThrow(
      /migration 1 is older than applied migration 2/,
    );
  });
});

describe("testDatabaseUrl", () => {
  it("uses TEST_DATABASE_URL when set", () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: "postgres://u:p@h:5432/x_test" })).toBe("postgres://u:p@h:5432/x_test");
  });

  it("derives <db>_test from DATABASE_URL", () => {
    expect(testDatabaseUrl({ DATABASE_URL: "postgres://u:p@h:5432/incident_tracker" })).toBe(
      "postgres://u:p@h:5432/incident_tracker_test",
    );
  });

  it("refuses a database whose name does not end in _test", () => {
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: "postgres://u:p@h:5432/incident_tracker" })).toThrow(/must end in _test/);
  });

  it("explains what to do when no URL is set", () => {
    expect(() => testDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });

  it("never includes the password in its errors", () => {
    let message = "";
    try {
      testDatabaseUrl({ TEST_DATABASE_URL: "postgres://u:hunter2@h:5432/prod" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must end in _test/);
    expect(message).not.toContain("hunter2");
  });
});
