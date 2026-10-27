import { describe, expect, it } from "vitest";
import { buildHealth } from "./health";

describe("buildHealth", () => {
  it("reports ok with HTTP 200 when the database is reachable", () => {
    expect(buildHealth({ dbOk: true })).toEqual({
      httpStatus: 200,
      body: { status: "ok", db: "ok" },
    });
  });

  it("reports degraded with HTTP 503 when the database is down", () => {
    expect(buildHealth({ dbOk: false })).toEqual({
      httpStatus: 503,
      body: { status: "degraded", db: "down" },
    });
  });

  it("never includes error details in the body", () => {
    const { body } = buildHealth({ dbOk: false });
    expect(Object.keys(body).sort()).toEqual(["db", "status"]);
  });
});
