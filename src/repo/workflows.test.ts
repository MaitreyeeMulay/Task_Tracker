import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "./workflow-policy.ts";

// Applies the workflow policy to every workflow in the repository.
const dir = join(process.cwd(), ".github", "workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

describe("repository workflows", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s follows the workflow policy", (file) => {
    expect(checkWorkflow(readFileSync(join(dir, file), "utf8"))).toEqual([]);
  });
});
