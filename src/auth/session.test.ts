import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions, verifySessionToken } from "./session.ts";

const SECRET = "session-secret-0123456789abcdef0123456789";
const OLD = "old-session-secret-0123456789abcdef012345";
const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-01T12:00:00Z");
const HOUR = 3600 * 1000;

describe("session tokens", () => {
  it("round-trips a user id", () => {
    const token = createSessionToken(USER, { secret: SECRET, now: NOW });
    expect(verifySessionToken(token, { secrets: [SECRET], now: NOW })).toEqual({ userId: USER });
  });

  it("expire after 8 hours", () => {
    const token = createSessionToken(USER, { secret: SECRET, now: NOW });
    expect(verifySessionToken(token, { secrets: [SECRET], now: new Date(NOW.getTime() + 8 * HOUR - 1000) })).toEqual({ userId: USER });
    expect(verifySessionToken(token, { secrets: [SECRET], now: new Date(NOW.getTime() + 8 * HOUR + 1000) })).toBeNull();
  });

  it("still verify with the previous secret during rotation", () => {
    const token = createSessionToken(USER, { secret: OLD, now: NOW });
    expect(verifySessionToken(token, { secrets: [SECRET, OLD], now: NOW })).toEqual({ userId: USER });
    expect(verifySessionToken(token, { secrets: [SECRET], now: NOW })).toBeNull();
  });

  it("reject a tampered user id", () => {
    const token = createSessionToken(USER, { secret: SECRET, now: NOW });
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ uid: "22222222-2222-4222-8222-222222222222", exp: NOW.getTime() + HOUR })).toString("base64url");
    expect(verifySessionToken(`${forgedPayload}.${sig}`, { secrets: [SECRET], now: NOW })).toBeNull();
  });

  it.each(["", "abc", "a.b.c", ".", "x.", ".y", "%%%.%%%"])("reject malformed token %j", (token) => {
    expect(verifySessionToken(token, { secrets: [SECRET], now: NOW })).toBeNull();
  });

  it("return null when there is no cookie", () => {
    expect(verifySessionToken(undefined, { secrets: [SECRET], now: NOW })).toBeNull();
  });

  it("reject a token signed for a different purpose (payload without a valid uid)", () => {
    expect(() => createSessionToken("not-a-uuid", { secret: SECRET, now: NOW })).toThrow(/user id/);
  });

  it("refuse short secrets", () => {
    expect(() => createSessionToken(USER, { secret: "short", now: NOW })).toThrow(/at least 32/);
    expect(() => verifySessionToken("x.y", { secrets: ["short"], now: NOW })).toThrow(/at least 32/);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax, path /, 8 hours", () => {
    expect(sessionCookieOptions("development")).toEqual({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 8 * 3600 });
  });

  it("is Secure in production", () => {
    expect(sessionCookieOptions("production").secure).toBe(true);
  });

  it("has a fixed name", () => {
    expect(SESSION_COOKIE).toBe("tracker_session");
  });
});
