import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isLocked, lockoutAfterFailure } from "./lockout.ts";
import { hashPassword, passwordProblem, verifyPassword } from "./password.ts";

// Pre-authentication database access. Everything here runs as app_auth, which
// can read only login columns of users and update the failure counters.
// Every failure gives the same answer (no account enumeration), and an unknown
// email still costs one scrypt verification so timing does not tell either.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A valid hash of a random password, used to equalise timing for unknown users.
const DUMMY_HASH = hashPassword(randomBytes(32).toString("base64url"));

async function asAuth<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE app_auth");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } finally {
    db.release();
  }
}

async function audit(db: PoolClient, action: string, userId: string): Promise<void> {
  await db.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id) VALUES ($1, $2, 'user', $3)`, [userId, action, userId]);
}

export async function passwordLogin(
  pool: Pool,
  { email, password, now }: { email: string; password: string; now: Date },
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const candidate = email.trim().slice(0, 320);
  return asAuth(pool, async (db) => {
    const { rows } = await db.query<{ id: string; password_hash: string | null; failed_logins: number; locked_until: Date | null }>(
      "SELECT id, password_hash, failed_logins, locked_until FROM users WHERE lower(email) = lower($1) FOR UPDATE",
      [candidate],
    );
    const user = rows[0];
    if (!user?.password_hash) {
      await verifyPassword(password, await DUMMY_HASH);
      return { ok: false };
    }
    if (isLocked(user.locked_until, now)) {
      await verifyPassword(password, await DUMMY_HASH);
      await audit(db, "auth.login_failed", user.id);
      return { ok: false };
    }

    if (await verifyPassword(password, user.password_hash)) {
      await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1", [user.id, now]);
      await audit(db, "auth.login_succeeded", user.id);
      return { ok: true, userId: user.id };
    }

    const next = lockoutAfterFailure(user.failed_logins, now);
    await db.query("UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1", [user.id, next.failedLogins, next.lockedUntil]);
    await audit(db, next.lockedUntil ? "auth.locked" : "auth.login_failed", user.id);
    return { ok: false };
  });
}

export async function setPassword(pool: Pool, { userId, password }: { userId: string; password: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  if (!UUID.test(userId)) return { ok: false, error: "Unknown user." };
  const hash = await hashPassword(password);
  return asAuth(pool, async (db) => {
    const { rowCount } = await db.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1", [userId, hash]);
    if (rowCount !== 1) return { ok: false, error: "Unknown user." };
    await audit(db, "auth.password_set", userId);
    return { ok: true };
  });
}

/** Development email-only login: id lookup, through the same narrow role. */
export async function lookupUserIdByEmail(pool: Pool, email: string): Promise<string | null> {
  return asAuth(pool, async (db) => {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [email.trim().slice(0, 320)]);
    return rows[0]?.id ?? null;
  });
}
