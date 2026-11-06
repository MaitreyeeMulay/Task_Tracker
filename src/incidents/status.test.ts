import { describe, expect, it } from "vitest";
import { allowedNextStatuses, planReopen, planTransition } from "./status.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

describe("allowedNextStatuses", () => {
  it.each([
    ["triggered", ["acknowledged", "mitigated", "resolved"]],
    ["acknowledged", ["mitigated", "resolved"]],
    ["mitigated", ["resolved"]],
    ["resolved", []],
  ] as const)("%s -> %j", (from, to) => {
    expect(allowedNextStatuses(from)).toEqual(to);
  });
});

describe("planReopen", () => {
  it("reopens a resolved incident as acknowledged and clears the later timestamps", () => {
    expect(planReopen("resolved", NOW)).toEqual({
      ok: true,
      status: "acknowledged",
      set: { acknowledged_at: NOW, mitigated_at: null, resolved_at: null },
    });
  });

  it.each(["triggered", "acknowledged", "mitigated"] as const)("refuses to reopen a %s incident", (from) => {
    expect(planReopen(from, NOW)).toEqual({ ok: false, error: "not_resolved" });
  });
});

describe("planTransition", () => {
  it("acknowledging sets acknowledged_at", () => {
    expect(planTransition("triggered", "acknowledged", NOW)).toEqual({ ok: true, status: "acknowledged", set: { acknowledged_at: NOW } });
  });

  it("resolving straight from triggered sets resolved_at only", () => {
    expect(planTransition("triggered", "resolved", NOW)).toEqual({ ok: true, status: "resolved", set: { resolved_at: NOW } });
  });

  it("mitigating sets mitigated_at", () => {
    expect(planTransition("acknowledged", "mitigated", NOW)).toEqual({ ok: true, status: "mitigated", set: { mitigated_at: NOW } });
  });

  it.each([
    ["resolved", "triggered"],
    ["resolved", "acknowledged"],
    ["mitigated", "acknowledged"],
    ["acknowledged", "acknowledged"],
    ["acknowledged", "triggered"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(planTransition(from, to, NOW)).toEqual({ ok: false, error: `cannot move from ${from} to ${to}` });
  });

  it("refuses an unknown target status", () => {
    expect(planTransition("triggered", "paused", NOW)).toEqual({ ok: false, error: "unknown status" });
  });
});
