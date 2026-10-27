import { describe, expect, it } from "vitest";
import { checkWorkflow } from "./workflow-policy.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("checkWorkflow", () => {
  it("accepts SHA-pinned actions with top-level permissions", () => {
    const text = `permissions:\n  contents: read\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n`;
    expect(checkWorkflow(text)).toEqual([]);
  });

  it("rejects an action pinned to a tag", () => {
    const text = `permissions:\n  contents: read\nsteps:\n  - uses: actions/checkout@v7\n`;
    expect(checkWorkflow(text)).toEqual(["line 4: action not pinned to a commit SHA: actions/checkout@v7"]);
  });

  it("rejects an action pinned to a branch", () => {
    expect(checkWorkflow(`permissions: {}\n- uses: foo/bar@main\n`)).toEqual([
      "line 2: action not pinned to a commit SHA: foo/bar@main",
    ]);
  });

  it("rejects a workflow without top-level permissions", () => {
    expect(checkWorkflow(`jobs:\n  a:\n    permissions:\n      contents: read\n`)).toEqual([
      "missing top-level permissions block",
    ]);
  });

  it("rejects write-all permissions", () => {
    expect(checkWorkflow(`permissions: write-all\n`)).toEqual(["permissions: write-all is not allowed"]);
  });

  it("rejects pull_request_target, which runs fork code with secrets", () => {
    expect(checkWorkflow(`on:\n  pull_request_target:\npermissions: {}\n`)).toEqual([
      "pull_request_target is not allowed",
    ]);
  });

  it("allows local actions and docker images pinned by digest", () => {
    const text = `permissions: {}\n- uses: ./.github/actions/x\n- uses: docker://alpine@sha256:${"a".repeat(64)}\n`;
    expect(checkWorkflow(text)).toEqual([]);
  });

  it("rejects docker images not pinned by digest", () => {
    expect(checkWorkflow(`permissions: {}\n- uses: docker://alpine:3\n`)).toEqual([
      "line 2: docker image not pinned by digest: docker://alpine:3",
    ]);
  });
});
