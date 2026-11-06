import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { hashPassword } from "../../src/auth/password.ts";
import { lookupUserIdByEmail, passwordLogin, setPassword } from "../../src/auth/login.ts";
import { dbError } from "./helpers.ts";

// M5: login with lockout. Runs as the narrow app_auth role.

let pool: pg.Pool;
const NOW = new Date("2026-11-08T12:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const PASSWORD = "correct horse battery staple";

beforeAll(() => {
  pool = new pg.Pool({ connectionString: inject("testDatabaseUrl"), max: 4 });
});

afterAll(async () => {
  await pool.end();
});

async function seedUser(withPassword = true): Promise<{ id: string; email: string }> {
  const email = `u-${randomUUID().slice(0, 8)}@login.test`;
  const hash = withPassword ? await hashPassword(PASSWORD) : null;
  const { rows } = await pool.query("INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'U', $2) RETURNING id", [email, hash]);
  return { id: rows[0].id, email };
}

async function state(id: string) {
  return (await pool.query("SELECT failed_logins, locked_until FROM users WHERE id = $1", [id])).rows[0];
}

describe("password login", () => {
  it("accepts the right password (email is case-insensitive) and resets the failure count", async () => {
    const u = await seedUser();
    await passwordLogin(pool, { email: u.email, password: "wrong password!!", now: NOW });
    expect(await passwordLogin(pool, { email: u.email.toUpperCase(), password: PASSWORD, now: NOW })).toEqual({ ok: true, userId: u.id });
    expect(await state(u.id)).toEqual({ failed_logins: 0, locked_until: null });
  });

  it("refuses a wrong password and counts it", async () => {
    const u = await seedUser();
    expect(await passwordLogin(pool, { email: u.email, password: "wrong password!!", now: NOW })).toEqual({ ok: false });
    expect((await state(u.id)).failed_logins).toBe(1);
  });

  it("locks the account after 5 failures; even the right password fails until the lock ends", async () => {
    const u = await seedUser();
    for (let i = 0; i < 5; i++) await passwordLogin(pool, { email: u.email, password: "wrong password!!", now: NOW });
    expect((await state(u.id)).locked_until).toEqual(later(15));
    expect(await passwordLogin(pool, { email: u.email, password: PASSWORD, now: later(14) })).toEqual({ ok: false });
    expect(await passwordLogin(pool, { email: u.email, password: PASSWORD, now: later(16) })).toEqual({ ok: true, userId: u.id });
  });

  it("gives the same answer for an unknown email and for a user without a password", async () => {
    const noPassword = await seedUser(false);
    expect(await passwordLogin(pool, { email: "nobody@login.test", password: PASSWORD, now: NOW })).toEqual({ ok: false });
    expect(await passwordLogin(pool, { email: noPassword.email, password: PASSWORD, now: NOW })).toEqual({ ok: false });
  });

  it("setPassword enforces the policy and stores only a hash", async () => {
    const u = await seedUser(false);
    expect(await setPassword(pool, { userId: u.id, password: "short" })).toEqual({ ok: false, error: "Use at least 12 characters." });
    expect(await setPassword(pool, { userId: u.id, password: PASSWORD })).toEqual({ ok: true });
    const stored = (await pool.query("SELECT password_hash FROM users WHERE id = $1", [u.id])).rows[0].password_hash as string;
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain(PASSWORD);
    expect(await passwordLogin(pool, { email: u.email, password: PASSWORD, now: NOW })).toEqual({ ok: true, userId: u.id });
  });

  it("dev login looks up a user id by email through the same narrow role", async () => {
    const u = await seedUser();
    expect(await lookupUserIdByEmail(pool, u.email.toUpperCase())).toBe(u.id);
    expect(await lookupUserIdByEmail(pool, "nobody@login.test")).toBeNull();
  });
});

describe("the auth role", () => {
  it("can read only login columns and touches nothing else", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_auth");
      for (const sql of ["SELECT display_name FROM users", "SELECT * FROM incidents", "SELECT * FROM memberships", "UPDATE users SET email = 'x'"]) {
        expect((await dbError(client, sql))?.code, sql).toBe("42501");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
