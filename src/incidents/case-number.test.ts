import { describe, expect, it } from "vitest";
import { formatCaseNumber, parseCaseNumber } from "./case-number.ts";

describe("case numbers", () => {
  it("formats as INC-<number>", () => {
    expect(formatCaseNumber(1001)).toBe("INC-1001");
  });

  it.each([
    ["INC-1001", 1001],
    ["inc-42", 42],
    [" INC-7 ", 7],
  ])("parses %j", (text, number) => {
    expect(parseCaseNumber(text)).toBe(number);
  });

  it.each(["1001", "INC-", "INC-abc", "INC-1.5", "INC--1", "INC-0", "INC-99999999999999999999", "ABC-12"])("rejects %j", (text) => {
    expect(parseCaseNumber(text)).toBeNull();
  });
});
