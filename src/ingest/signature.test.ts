import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "./signature.ts";

const CURRENT = "current-secret-0123456789abcdef0123456789";
const PREVIOUS = "previous-secret-0123456789abcdef012345678";
const NOW = new Date("2026-10-28T12:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = '{"title":"disk full"}';

function verify(overrides: Partial<Parameters<typeof verifyWebhook>[0]> = {}) {
  return verifyWebhook({
    rawBody: BODY,
    timestamp: TS,
    signature: signWebhook(CURRENT, TS, BODY),
    secrets: [CURRENT],
    now: NOW,
    ...overrides,
  });
}

describe("verifyWebhook", () => {
  it("accepts a correctly signed, fresh request", () => {
    expect(verify()).toEqual({ ok: true });
  });

  describe("secret rotation", () => {
    it("accepts the previous secret while two are configured", () => {
      expect(verify({ signature: signWebhook(PREVIOUS, TS, BODY), secrets: [CURRENT, PREVIOUS] })).toEqual({ ok: true });
    });

    it("rejects the previous secret once it is removed", () => {
      expect(verify({ signature: signWebhook(PREVIOUS, TS, BODY), secrets: [CURRENT] })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    });

    it("refuses a configuration with no secrets", () => {
      expect(() => verify({ secrets: [] })).toThrow(/at least one secret/);
    });

    it("refuses more than two secrets", () => {
      expect(() => verify({ secrets: [CURRENT, PREVIOUS, "third-secret-0123456789abcdef0123456"] })).toThrow(/at most two/);
    });

    it("refuses short secrets", () => {
      expect(() => verify({ secrets: ["short"] })).toThrow(/at least 32 characters/);
    });
  });

  describe("forgery", () => {
    it("rejects a tampered body", () => {
      expect(verify({ rawBody: '{"title":"all fine"}' })).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rejects a signature made with an unknown secret", () => {
      expect(verify({ signature: signWebhook("attacker-secret-0123456789abcdef01234", TS, BODY) })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    });

    it("rejects a changed timestamp (it is part of what is signed)", () => {
      const later = String(Number(TS) + 10);
      expect(verify({ timestamp: later })).toEqual({ ok: false, reason: "bad_signature" });
    });

    it.each(["v1=", "v1=zz", "v2=" + "a".repeat(64), "a".repeat(64), "v1=" + "a".repeat(63)])(
      "rejects malformed signature %j",
      (signature) => {
        expect(verify({ signature })).toEqual({ ok: false, reason: "bad_signature" });
      },
    );
  });

  describe("replay window (5 minutes)", () => {
    it("accepts a request 299 seconds old", () => {
      const ts = String(Number(TS) - 299);
      expect(verify({ timestamp: ts, signature: signWebhook(CURRENT, ts, BODY) })).toEqual({ ok: true });
    });

    it("rejects a request 301 seconds old", () => {
      const ts = String(Number(TS) - 301);
      expect(verify({ timestamp: ts, signature: signWebhook(CURRENT, ts, BODY) })).toEqual({ ok: false, reason: "stale" });
    });

    it("rejects a request from too far in the future", () => {
      const ts = String(Number(TS) + 301);
      expect(verify({ timestamp: ts, signature: signWebhook(CURRENT, ts, BODY) })).toEqual({ ok: false, reason: "stale" });
    });

    it.each(["abc", "1.5", "-1", "99999999999999999999"])("rejects malformed timestamp %j", (timestamp) => {
      expect(verify({ timestamp })).toEqual({ ok: false, reason: "bad_timestamp" });
    });
  });

  it("rejects missing headers", () => {
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ signature: "", timestamp: "" })).toEqual({ ok: false, reason: "missing_headers" });
  });
});

describe("signWebhook", () => {
  it("produces v1=<64 hex chars>", () => {
    expect(signWebhook(CURRENT, TS, BODY)).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});
