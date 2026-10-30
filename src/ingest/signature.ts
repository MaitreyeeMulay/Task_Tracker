import { createHmac, timingSafeEqual } from "node:crypto";

// Generic webhook signing scheme:
//   X-Timestamp: <unix seconds>
//   X-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
// The timestamp is signed, so it cannot be changed to dodge the replay window.

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale" | "bad_signature" };

export interface VerifyInput {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  /** Current secret first; a second one only during rotation. */
  secrets: string[];
  now: Date;
}

const TOLERANCE_SECONDS = 300;
const MIN_SECRET_LENGTH = 32;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const TIMESTAMP = /^\d{1,12}$/;

function hmac(secret: string, timestamp: string, rawBody: string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${hmac(secret, timestamp, rawBody).toString("hex")}`;
}

function assertSecrets(secrets: string[]): void {
  if (secrets.length === 0) throw new Error("webhook verification needs at least one secret");
  if (secrets.length > 2) throw new Error("webhook verification accepts at most two secrets (current and previous)");
  if (secrets.some((s) => s.length < MIN_SECRET_LENGTH)) {
    throw new Error(`webhook secrets must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

export function verifyWebhook({ rawBody, timestamp, signature, secrets, now }: VerifyInput): VerifyResult {
  assertSecrets(secrets);
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const ageSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (ageSeconds > TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

  const hex = SIGNATURE.exec(signature)?.[1];
  if (!hex) return { ok: false, reason: "bad_signature" };
  const given = Buffer.from(hex, "hex");

  // Check every secret (no early exit) with a constant-time compare.
  let valid = false;
  for (const secret of secrets) {
    if (timingSafeEqual(given, hmac(secret, timestamp, rawBody))) valid = true;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
