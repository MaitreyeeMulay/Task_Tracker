# Future work: checks designed but not run

The live AWS stack ran once, on 2026-11-16 (M6-D), and was then destroyed. The owner decided on 2026-11-17 not to run a second live window. Three of the five M6 acceptance checks in `SPEC.md` were therefore **never run**. This page records how each one would be done, so the claim stays honest: the design is in the repository, but there is no evidence that it works.

To run any of them, bring the stack up first (`terraform apply -var live=true`, set the GitHub `production` variables from `terraform output deploy`, run `deploy.yml`). The steps are recorded in `docs/decisions.md` (M6-D). The stack costs about $0.08 an hour. Tear it down afterwards with `terraform apply -var live=false`.

## 1. An unsigned image is rejected

**SPEC:** "an unsigned image is rejected."

**What exists:** `deploy.yml` verifies a cosign signature before it changes anything. The signature must come from this repository's `deploy.yml` on `main`. The image must also be `<this ECR repository>@sha256:<digest>`. The deploy-time Conftest policy enforces the digest form too, and it has Rego unit tests.

**How it would be tested:**

1. Push an image to the ECR repository without signing it:
   ```sh
   docker pull public.ecr.aws/docker/library/busybox:1.37.0
   docker tag public.ecr.aws/docker/library/busybox:1.37.0 <repository_url>:unsigned-test
   docker push <repository_url>:unsigned-test   # note the sha256 digest it prints
   ```
2. Run `deploy.yml` with `image = <repository_url>@sha256:<digest>` and approve it.
3. **Expected:** the run fails at "Verify the image signature" with `Rejected: … is not signed by the deploy workflow on main`. Register, Migrate and Roll out are skipped, and the ECS service still runs the previous task definition revision.
4. **Second case:** an image from another registry, such as `docker.io/library/node@sha256:…`. It should be rejected by the repository check in the same step.

## 2. ZAP baseline with no high findings

**SPEC:** "ZAP reports no high findings" (OWASP ZAP baseline, fail on high, report stored).

**What exists:** nothing yet. There is no ZAP job.

**How it would be done:**

1. Add a manual workflow `zap.yml`, or a job after "Roll out" in `deploy.yml`:
   - Set `permissions: contents: read` only.
   - Pin `zaproxy/action-baseline` to a commit SHA.
   - Target the CloudFront URL, with a `rules.tsv` that fails on high.
   - Upload the HTML and JSON reports as a build artifact.
2. Signed-in pages need a ZAP authentication context using a demo account. The baseline scan alone covers the public pages: `/login`, the health endpoint, and the redirects.
3. **Expected:** no high findings. The security headers (CSP with nonce, HSTS, `X-Frame-Options`, `nosniff`) were confirmed on the live site, which covers the most common baseline alerts. Anything at medium or below goes into `docs/security-decisions.md`.

## 3. Timed restore drill

**SPEC:** "the restore time is measured and written down."

**What exists:** RDS automated backups are kept for 1 day (`backup_retention_period = 1`), which allows point-in-time restore.

**How it would be done:**

1. Write a marker row (for example, a new incident through the app), then wait about 5 minutes so it is in the backup.
2. Start a timer, then restore to a new instance:
   ```sh
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier incident-tracker-dev \
     --target-db-instance-identifier incident-tracker-dev-restore \
     --use-latest-restorable-time \
     --db-subnet-group-name incident-tracker-dev \
     --vpc-security-group-ids <database security group> \
     --no-publicly-accessible
   aws rds wait db-instance-available --db-instance-identifier incident-tracker-dev-restore
   ```
3. Stop the timer when the instance is available. Then connect from a one-off task (the migrate task definition, pointed at the restored endpoint) and check that the marker row is there.
4. Record the time from start to available, and from start to verified, in `docs/decisions.md`. Then delete the restored instance with `--skip-final-snapshot`. It is outside Terraform, so `terraform destroy` would not remove it.
5. **Expected:** about 10–20 minutes for a db.t4g.micro. This is the measured recovery time; the recovery point is within 5 minutes of failure.

## Also never exercised live

- **A real SES email.** The worker started with the SES provider and the sender identity was verified, but no notification was sent during the window. SES is in sandbox mode, so it can only send to verified addresses.
- **Load or failover.** One task, one AZ for the database, no Multi-AZ. These were accepted for cost in `docs/security-decisions.md`.
