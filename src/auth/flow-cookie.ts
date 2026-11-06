import { createHmac, timingSafeEqual } from "node:crypto";

// Short-lived, HMAC-signed cookie that carries the OIDC state, nonce and PKCE
// verifier between /auth/oidc/start and /auth/oidc/callback. Signed with the
// session secret(s), so it cannot be forged or swapped, and expires in 10 minutes.

export interface Flow {
  state: string;
  nonce: string;
  verifier: string;
}

export const FLOW_COOKIE = "tracker_oidc_flow";
const TTL_MS = 10 * 60_000;

const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(`oidc-flow.${payload}`).digest();

export function sealFlow(flow: Flow, { secret, now }: { secret: string; now: Date }): string {
  const payload = Buffer.from(JSON.stringify({ ...flow, exp: now.getTime() + TTL_MS })).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

export function openFlow(sealed: string | undefined, { secrets, now }: { secrets: string[]; now: Date }): Flow | null {
  if (!sealed) return null;
  const [payload, signature, extra] = sealed.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const valid = secrets.some((secret) => {
    const expected = mac(secret, payload);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return null;
  try {
    const { state, nonce, verifier, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string" || typeof exp !== "number") return null;
    if (exp <= now.getTime()) return null;
    return { state, nonce, verifier };
  } catch {
    return null;
  }
}
