import { createHmac, timingSafeEqual } from "node:crypto";
import type { Environment } from "../lib/config.ts";

// Stateless session cookie: base64url(JSON {uid, exp}) + "." + base64url(HMAC-SHA256).
// No dependency needed. Two secrets may be valid at once, for rotation without
// logging everyone out (same pattern as webhook secrets).

export const SESSION_COOKIE = "tracker_session";
const TTL_MS = 8 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`session secrets must be at least ${MIN_SECRET_LENGTH} characters`);
}

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createSessionToken(userId: string, { secret, now }: { secret: string; now: Date }): string {
  assertSecret(secret);
  if (!UUID.test(userId)) throw new Error("session user id must be a UUID");
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now.getTime() + TTL_MS })).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

export function verifySessionToken(token: string | undefined, { secrets, now }: { secrets: string[]; now: Date }): { userId: string } | null {
  secrets.forEach(assertSecret);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;

  const given = Buffer.from(signature, "base64url");
  let valid = false;
  for (const secret of secrets) {
    const expected = mac(secret, payload);
    if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
  }
  if (!valid) return null;

  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid?: unknown; exp?: unknown };
    if (typeof uid !== "string" || !UUID.test(uid) || typeof exp !== "number" || exp <= now.getTime()) return null;
    return { userId: uid };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(environment: Environment) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: environment === "production",
    path: "/",
    maxAge: TTL_MS / 1000,
  };
}
