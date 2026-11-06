import { describe, expect, it } from "vitest";
import { DEFAULT_SLA, afterSendAttempt, slaDueTimes } from "./policy.ts";

const OPENED = new Date("2026-11-08T10:00:00Z");
const NOW = new Date("2026-11-08T10:30:00Z");

describe("slaDueTimes", () => {
  it.each([
    ["SEV1", "2026-11-08T10:05:00.000Z", "2026-11-08T11:00:00.000Z"],
    ["SEV2", "2026-11-08T10:15:00.000Z", "2026-11-08T14:00:00.000Z"],
    ["SEV3", "2026-11-08T11:00:00.000Z", "2026-11-09T10:00:00.000Z"],
    ["SEV4", "2026-11-08T14:00:00.000Z", "2026-11-11T10:00:00.000Z"],
  ] as const)("%s: ack by %s, resolve by %s", (severity, ack, resolve) => {
    const due = slaDueTimes(severity, OPENED, DEFAULT_SLA);
    expect(due.ackDue.toISOString()).toBe(ack);
    expect(due.resolveDue.toISOString()).toBe(resolve);
  });
});

describe("afterSendAttempt", () => {
  it("marks a delivered message as sent", () => {
    expect(afterSendAttempt({ outcome: "delivered", messageId: "m-1" }, 1, NOW)).toEqual({ status: "sent", messageId: "m-1" });
  });

  it("retries a definite rejection with backoff (1, 5, 25 minutes)", () => {
    const rejected = { outcome: "rejected" as const, code: "Throttling" };
    expect(afterSendAttempt(rejected, 1, NOW)).toEqual({ status: "pending", retryAt: new Date("2026-11-08T10:31:00Z"), code: "Throttling" });
    expect(afterSendAttempt(rejected, 2, NOW)).toEqual({ status: "pending", retryAt: new Date("2026-11-08T10:35:00Z"), code: "Throttling" });
    expect(afterSendAttempt(rejected, 3, NOW)).toEqual({ status: "pending", retryAt: new Date("2026-11-08T10:55:00Z"), code: "Throttling" });
  });

  it("gives up after 4 rejected attempts", () => {
    expect(afterSendAttempt({ outcome: "rejected", code: "Throttling" }, 4, NOW)).toEqual({ status: "failed", code: "Throttling" });
  });

  it("never retries a permanent rejection", () => {
    expect(afterSendAttempt({ outcome: "rejected", code: "InvalidAddress", permanent: true }, 1, NOW)).toEqual({ status: "failed", code: "InvalidAddress" });
  });

  it("flags an ambiguous result for a person instead of retrying (it may have been sent)", () => {
    expect(afterSendAttempt({ outcome: "unknown", code: "Timeout" }, 1, NOW)).toEqual({ status: "needs_review", code: "Timeout" });
  });
});
