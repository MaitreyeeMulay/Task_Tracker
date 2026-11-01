import { describe, expect, it } from "vitest";
import { parseRunbook } from "./markdown.ts";

describe("parseRunbook", () => {
  it("reads headings, paragraphs, lists, code and checklist steps", () => {
    const md = [
      "# Checkout 5xx",
      "",
      "Customers see errors at checkout.",
      "Check the dashboard first.",
      "",
      "## Steps",
      "- [ ] Check the error rate dashboard",
      "- [x] Roll back the last deploy",
      "",
      "- note one",
      "* note two",
      "",
      "```",
      "kubectl rollout undo deploy/checkout",
      "```",
    ].join("\n");

    expect(parseRunbook(md)).toEqual({
      blocks: [
        { type: "heading", level: 1, text: "Checkout 5xx" },
        { type: "paragraph", text: "Customers see errors at checkout. Check the dashboard first." },
        { type: "heading", level: 2, text: "Steps" },
        { type: "step", index: 0, text: "Check the error rate dashboard" },
        { type: "step", index: 1, text: "Roll back the last deploy" },
        { type: "list", items: ["note one", "note two"] },
        { type: "code", text: "kubectl rollout undo deploy/checkout" },
      ],
      steps: ["Check the error rate dashboard", "Roll back the last deploy"],
    });
  });

  it("keeps HTML as literal text (no markup is ever produced)", () => {
    const { blocks } = parseRunbook('<script>alert("x")</script>\n- [ ] <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([
      { type: "paragraph", text: '<script>alert("x")</script>' },
      { type: "step", index: 0, text: "<img src=x onerror=alert(1)>" },
    ]);
  });

  it("handles Windows line endings", () => {
    expect(parseRunbook("# A\r\n- [ ] one\r\n").steps).toEqual(["one"]);
  });

  it("treats an unclosed code fence as code to the end", () => {
    expect(parseRunbook("```\nline 1\nline 2").blocks).toEqual([{ type: "code", text: "line 1\nline 2" }]);
  });

  it("ignores empty checklist items", () => {
    expect(parseRunbook("- [ ]   \n- [ ] real").steps).toEqual(["real"]);
  });

  it("caps the number of steps at 100", () => {
    const md = Array.from({ length: 150 }, (_, i) => `- [ ] step ${i}`).join("\n");
    expect(parseRunbook(md).steps).toHaveLength(100);
  });

  it("returns nothing for an empty document", () => {
    expect(parseRunbook("")).toEqual({ blocks: [], steps: [] });
  });
});
