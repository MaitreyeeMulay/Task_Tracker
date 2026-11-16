import { describe, expect, it } from "vitest";
import { isActivePath, nextTheme, parseTheme } from "./ui.ts";
import { proseBlocks } from "@/runbooks/markdown";
import { parseRunbook } from "@/runbooks/markdown";

describe("parseTheme", () => {
  it("accepts light and dark", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("falls back to system for anything else", () => {
    expect(parseTheme(undefined)).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme("DARK; x=1")).toBe("system");
  });
});

describe("nextTheme", () => {
  it("cycles system → dark → light → system", () => {
    expect(nextTheme("system")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
  });
});

describe("isActivePath", () => {
  it("matches the section and its sub-pages", () => {
    expect(isActivePath("/incidents", "/incidents")).toBe(true);
    expect(isActivePath("/incidents/INC-1004", "/incidents")).toBe(true);
  });

  it("does not match a different section that shares a prefix", () => {
    expect(isActivePath("/incidents-archive", "/incidents")).toBe(false);
    expect(isActivePath("/checklists", "/incidents")).toBe(false);
  });

  it("treats an incident's checklist as part of incidents, not checklists", () => {
    expect(isActivePath("/incidents/INC-1/checklists/abc", "/checklists")).toBe(false);
  });
});

describe("proseBlocks", () => {
  it("drops a heading whose section only holds steps", () => {
    const md = ["# Checkout", "Intro.", "## Diagnose", "- [ ] Check", "## Mitigate", "```", "rollback", "```"].join("\n");
    const headings = proseBlocks(parseRunbook(md).blocks).flatMap((b) => (b.type === "heading" ? [b.text] : []));
    expect(headings).toEqual(["Checkout", "Mitigate"]);
  });

  it("keeps a parent heading when a sub-section under it has content", () => {
    const md = ["# Checkout", "## Notes", "Call the provider."].join("\n");
    const headings = proseBlocks(parseRunbook(md).blocks).flatMap((b) => (b.type === "heading" ? [b.text] : []));
    expect(headings).toEqual(["Checkout", "Notes"]);
  });

  it("never returns step blocks", () => {
    expect(proseBlocks(parseRunbook("- [ ] a\n- [ ] b").blocks)).toEqual([]);
  });
});
