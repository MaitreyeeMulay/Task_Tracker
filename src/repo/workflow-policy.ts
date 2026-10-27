// Line-based checks for GitHub workflow files (project rules in CLAUDE.md):
// actions pinned to a commit SHA, docker images pinned by digest, minimal
// top-level token permissions, and no pull_request_target.

const USES = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/;
const SHA_PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const DIGEST_PINNED = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

export function checkWorkflow(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);

  const topLevelPermissions = lines.find((line) => /^permissions:/.test(line));
  if (!topLevelPermissions) problems.push("missing top-level permissions block");
  if (lines.some((line) => /^\s*permissions:\s*write-all\b/.test(line))) {
    problems.push("permissions: write-all is not allowed");
  }
  if (lines.some((line) => /^\s*pull_request_target\s*:/.test(line))) {
    problems.push("pull_request_target is not allowed");
  }

  lines.forEach((line, index) => {
    const ref = USES.exec(line)?.[1];
    if (!ref || ref.startsWith("./")) return;
    if (ref.startsWith("docker://")) {
      if (!DIGEST_PINNED.test(ref)) problems.push(`line ${index + 1}: docker image not pinned by digest: ${ref}`);
    } else if (!SHA_PINNED.test(ref)) {
      problems.push(`line ${index + 1}: action not pinned to a commit SHA: ${ref}`);
    }
  });

  return problems;
}
