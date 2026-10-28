# GitHub repository setup

These are manual settings for `MaitreyeeMulay/Task_Tracker`. They can't live in code, so this file is the record. Re-check them at each milestone.

## 1. Code security (Settings → Advanced Security)

- [ ] **Private vulnerability reporting**: Enable. `SECURITY.md` relies on it.
- [ ] **Dependency graph**: Enabled (the default for public repos).
- [ ] **Dependabot alerts**: Enable.
- [ ] **Dependabot security updates**: Enable.
- [ ] **Secret Protection** (secret scanning): Enable.
- [ ] **Push protection**: Enable. It blocks pushes containing known secret formats.
- [ ] **Code scanning**: leave as is. CodeQL runs from `.github/workflows/codeql.yml` (advanced setup), so don't turn on "default setup" as well.

## 2. Actions (Settings → Actions → General)

- [ ] **Fork pull request workflows**: "Require approval for all external contributors".
- [ ] **Workflow permissions**: "Read repository contents and packages permissions".
- [ ] **Allow GitHub Actions to create and approve pull requests**: unchecked.

## 3. Ruleset for `main` (Settings → Rules → Rulesets → New branch ruleset)

- **Name:** `protect-main`
- **Enforcement status:** Active
- **Bypass list:** empty, so the rules apply to admins too.
- **Target branches:** Add target → Include default branch.
- **Rules:**
  - [ ] Restrict deletions
  - [ ] Block force pushes
  - [ ] Require linear history
  - [ ] Require a pull request before merging
    - Required approvals: **0**. This is a solo repo; see `docs/security-decisions.md`.
    - Dismiss stale approvals and require conversation resolution: on.
  - [ ] Require status checks to pass
    - Require branches to be up to date before merging: on.
    - Add these 8 checks. They appear in the search box once they have run at least once:
      - `Typecheck, lint, unit tests`
      - `Database tests (Postgres)`
      - `Docker image build`
      - `Terraform fmt, validate, test, tflint, Checkov`
      - `Secret scan (gitleaks, full history)`
      - `Dependency audit (fail on critical)`
      - `Analyze (javascript-typescript)`
      - `Analyze (actions)`
  - [ ] Require code scanning results
    - Tool: **CodeQL**. Security alerts: **High or higher**. Alerts: **Errors**.

After this, every change reaches `main` through a pull request, and pushing directly to `main` is rejected.

## 4. Gate proof (planted secret)

This shows that gitleaks fails the build. **Never merge this branch.**

```sh
git switch -c gate-proof/planted-secret
# Generates a random, fake, high-entropy "API key" at run time.
# No real secret exists anywhere, and none is written into this document.
node -e "console.log('export const payment_api_key = \"' + require('crypto').randomBytes(24).toString('base64url') + '\";')" > src/planted-secret.ts
git add src/planted-secret.ts
git commit -m "gate proof: planted fake secret (do not merge)"
git push -u origin gate-proof/planted-secret
```

Then open a pull request for it into `main`. Expected results:
- **Secret scan** fails, with a redacted `generic-api-key` finding.
- The PR **cannot be merged**, because the required check failed.
- If push protection blocks the push instead, that's also a passing proof. Note it, and don't bypass it.

Clean up afterwards: close the PR, delete the branch on GitHub, then run `git switch main && git branch -D gate-proof/planted-secret`. The fake value never reaches `main`.
