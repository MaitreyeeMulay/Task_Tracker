import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password.ts";
import { lockoutAfterFailure, isLocked } from "../auth/lockout.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { securityHeaders } from "./headers.ts";
import { isForgedRequest } from "./csrf.ts";

describe("passwords (scrypt)", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    for (const stored of ["", "plain", "scrypt$1$2$3$x$y", "bcrypt$..."]) {
      expect(await verifyPassword("anything at all", stored)).toBe(false);
    }
  });

  it("requires 12 to 128 characters", () => {
    expect(passwordProblem("short")).toBe("Use at least 12 characters.");
    expect(passwordProblem("x".repeat(129))).toBe("Use at most 128 characters.");
    expect(passwordProblem("twelve chars")).toBeNull();
  });
});

describe("lockout", () => {
  const NOW = new Date("2026-11-08T12:00:00Z");

  it("locks for 15 minutes after the 5th consecutive failure", () => {
    expect(lockoutAfterFailure(3, NOW)).toEqual({ failedLogins: 4, lockedUntil: null });
    expect(lockoutAfterFailure(4, NOW)).toEqual({ failedLogins: 5, lockedUntil: new Date("2026-11-08T12:15:00Z") });
  });

  it("knows when a lock is active", () => {
    expect(isLocked(new Date("2026-11-08T12:14:59Z"), NOW)).toBe(true);
    expect(isLocked(new Date("2026-11-08T11:59:59Z"), NOW)).toBe(false);
    expect(isLocked(null, NOW)).toBe(false);
  });
});

describe("rate limiter (fixed window)", () => {
  it("allows up to the limit per key per window, then refuses", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const t = 1_000_000;
    expect([1, 2, 3, 4].map(() => limiter.take("ip-1", t))).toEqual([true, true, true, false]);
    expect(limiter.take("ip-2", t)).toBe(true);
    expect(limiter.take("ip-1", t + 60_000)).toBe(true);
  });

  it("does not grow without bound", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 100 });
    for (let i = 0; i < 1_000; i++) limiter.take(`k${i}`, 0);
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });
});

describe("security headers", () => {
  it("sets a nonce-based CSP and hardening headers", () => {
    const headers = securityHeaders({ nonce: "abc123", production: true });
    expect(headers["Content-Security-Policy"]).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });
  });

  it("allows eval only in development (React fast refresh) and skips HSTS there", () => {
    const headers = securityHeaders({ nonce: "n", production: false });
    expect(headers["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("cross-site request check (CSRF)", () => {
  const base = { method: "POST", host: "tracker.example", path: "/incidents/1" };

  it("allows same-origin POSTs", () => {
    expect(isForgedRequest({ ...base, origin: "https://tracker.example", secFetchSite: "same-origin" })).toBe(false);
  });

  it.each([
    ["a foreign Origin", { origin: "https://evil.example", secFetchSite: "cross-site" }],
    ["a cross-site fetch without Origin", { origin: null, secFetchSite: "cross-site" }],
    ["a look-alike Origin", { origin: "https://tracker.example.evil.example", secFetchSite: "cross-site" }],
    ["the 'null' Origin (sandboxed frame)", { origin: "null", secFetchSite: "cross-site" }],
  ])("refuses %s", (_label, h) => {
    expect(isForgedRequest({ ...base, ...h })).toBe(true);
  });

  it("ignores safe methods", () => {
    expect(isForgedRequest({ ...base, method: "GET", origin: "https://evil.example", secFetchSite: "cross-site" })).toBe(false);
  });

  it("does not apply to signed machine endpoints (alert ingestion)", () => {
    expect(isForgedRequest({ ...base, path: "/api/ingest/sns/x", origin: null, secFetchSite: null })).toBe(false);
  });
});
