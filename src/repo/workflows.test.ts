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

  // These names are required status checks in the protect-main ruleset
  // (docs/github-setup.md). Renaming a job would block every pull request.
  it.each([
    "Typecheck, lint, unit tests",
    "Database tests (Postgres)",
    "Docker image build",
    "Terraform fmt, validate, test, tflint, Checkov",
    "Secret scan (gitleaks, full history)",
    "Dependency audit (fail on critical)",
  ])("keeps the required check name %j", (name) => {
    const all = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(all).toContain(`name: ${name}\n`);
  });

  it.each(files)("%s follows the workflow policy", (file) => {
    expect(checkWorkflow(readFileSync(join(dir, file), "utf8"))).toEqual([]);
  });
});
