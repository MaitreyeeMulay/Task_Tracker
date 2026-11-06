import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv.ts";

describe("csvCell", () => {
  it("leaves plain values alone", () => {
    expect(csvCell("incident.opened")).toBe("incident.opened");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it.each(["=HYPERLINK(\"http://evil\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "neutralises spreadsheet formula injection in %j",
    (value) => {
      const cell = csvCell(value);
      expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );
});

describe("toCsv", () => {
  it("writes a header and CRLF-separated rows", () => {
    expect(toCsv(["a", "b"], [[1, "x,y"], [2, null]])).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
});
