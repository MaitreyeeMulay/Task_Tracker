import { describe, expect, it } from "vitest";
import { sealFlow, openFlow } from "./flow-cookie.ts";

const SECRET = "session-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-11-08T12:00:00Z");
const FLOW = { state: "s1", nonce: "n1", verifier: "v1" };

describe("OIDC flow cookie", () => {
  it("round-trips the state, nonce and PKCE verifier", () => {
    expect(openFlow(sealFlow(FLOW, { secret: SECRET, now: NOW }), { secrets: [SECRET], now: NOW })).toEqual(FLOW);
  });

  it("expires after 10 minutes", () => {
    const sealed = sealFlow(FLOW, { secret: SECRET, now: NOW });
    expect(openFlow(sealed, { secrets: [SECRET], now: new Date(NOW.getTime() + 11 * 60_000) })).toBeNull();
  });

  it("rejects tampering and other secrets", () => {
    const sealed = sealFlow(FLOW, { secret: SECRET, now: NOW });
    const [payload, mac] = sealed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...FLOW, state: "attacker", exp: NOW.getTime() + 60_000 })).toString("base64url");
    expect(openFlow(`${forged}.${mac}`, { secrets: [SECRET], now: NOW })).toBeNull();
    expect(openFlow(`${payload}.${mac}`, { secrets: ["another-secret-0123456789abcdef0123456"], now: NOW })).toBeNull();
    expect(openFlow(undefined, { secrets: [SECRET], now: NOW })).toBeNull();
    expect(openFlow("garbage", { secrets: [SECRET], now: NOW })).toBeNull();
  });
});
