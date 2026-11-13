// Example data shared by the dev seed (scripts/seed-dev.ts) and the demo seed
// for the live AWS window (scripts/seed-demo.ts). Callers own the transaction.
import type { ClientBase } from "pg";
import { hashPassword } from "../auth/password.ts";

/** The seeded people. Dana is the Payments admin. */
export const DEMO_EMAILS = ["alice@example.test", "bob@example.test", "carol@example.test", "dana@example.test"];

const RUNBOOKS: { service: string; title: string; body: string }[] = [
  {
    service: "checkout-api",
    title: "Checkout 5xx errors",
    body: `# Checkout 5xx errors

Customers see errors when paying. Act fast: every minute costs orders.

## Diagnose
- [ ] Open the checkout dashboard and confirm the error rate
- [ ] Check whether a deploy went out in the last hour
- [ ] Check the payment provider's status page

## Mitigate
- [ ] If a recent deploy is the cause, roll it back
- [ ] Post an update in the incident channel

\`\`\`
kubectl rollout undo deployment/checkout-api
\`\`\`
`,
  },
  {
    service: "ledger",
    title: "Ledger disk filling up",
    body: `# Ledger disk filling up

- [ ] Find the largest directories on the volume
- [ ] Rotate or archive old logs
- [ ] If above 90%, expand the volume
`,
  },
  {
    service: "search-api",
    title: "Search API down",
    body: `# Search API down

- [ ] Check the load balancer health checks
- [ ] Restart unhealthy tasks
- [ ] Fail over to the standby cluster if restarts do not help
`,
  },
];

// M4: an admin for Payments, who receives escalations and reviews flagged emails.
export async function seedAdmin(client: ClientBase): Promise<void> {
  const result = await client.query(
    `WITH u AS (INSERT INTO users (email, display_name) SELECT 'dana@example.test', 'Dana'
                WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = 'dana@example.test') RETURNING id)
     INSERT INTO memberships (team_id, user_id, role)
     SELECT t.id, u.id, 'admin' FROM u, teams t WHERE t.name = 'Payments'`,
  );
  console.log(JSON.stringify({ event: result.rowCount ? "seed_admin_done" : "seed_admin_skipped" }));
}

export async function seedRunbooks(client: ClientBase): Promise<void> {
  const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM runbooks")).rows[0]?.n ?? 0;
  if (count > 0) {
    console.log(JSON.stringify({ event: "seed_runbooks_skipped", reason: "already seeded" }));
    return;
  }
  for (const rb of RUNBOOKS) {
    await client.query(
      `WITH r AS (INSERT INTO runbooks (team_id, service_id, title, body_md)
                  SELECT team_id, id, $2, $3 FROM services WHERE name = $1
                  RETURNING id, team_id)
       INSERT INTO checklist_steps (runbook_id, team_id, sort_order, text)
       SELECT r.id, r.team_id, s.pos, s.text FROM r CROSS JOIN LATERAL checklist_steps_from_markdown($3) s`,
      [rb.service, rb.title, rb.body],
    );
  }
  console.log(JSON.stringify({ event: "seed_runbooks_done", runbooks: RUNBOOKS.length }));
}

/** Returns false (and does nothing) if the core data already exists. */
export async function seedCore(client: ClientBase): Promise<boolean> {
  const existing = await client.query("SELECT 1 FROM users WHERE lower(email) = 'alice@example.test'");
  if (existing.rowCount) {
    console.log(JSON.stringify({ event: "seed_skipped", reason: "already seeded" }));
    return false;
  }
  await client.query(`
    WITH tp AS (INSERT INTO teams (name) VALUES ('Payments') RETURNING id),
         ts AS (INSERT INTO teams (name) VALUES ('Search') RETURNING id),
         ua AS (INSERT INTO users (email, display_name) VALUES ('alice@example.test', 'Alice') RETURNING id),
         ub AS (INSERT INTO users (email, display_name) VALUES ('bob@example.test', 'Bob') RETURNING id),
         uc AS (INSERT INTO users (email, display_name) VALUES ('carol@example.test', 'Carol') RETURNING id),
         m AS (INSERT INTO memberships (team_id, user_id, role)
               SELECT (SELECT id FROM tp), (SELECT id FROM ua), 'responder'
               UNION ALL SELECT (SELECT id FROM tp), (SELECT id FROM ub), 'viewer'
               UNION ALL SELECT (SELECT id FROM ts), (SELECT id FROM uc), 'responder'),
         sc AS (INSERT INTO services (team_id, name) SELECT id, 'checkout-api' FROM tp RETURNING id, team_id),
         sl AS (INSERT INTO services (team_id, name) SELECT id, 'ledger' FROM tp RETURNING id, team_id),
         ss AS (INSERT INTO services (team_id, name) SELECT id, 'search-api' FROM ts RETURNING id, team_id),
         ig AS (INSERT INTO integrations (service_id, kind, sns_topic_arn)
                SELECT id, 'sns', 'arn:aws:sns:eu-west-2:123456789012:checkout-alerts' FROM sc),
         i1 AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title, alert_count, opened_at)
                SELECT id, team_id, 'seed-1', 'SEV2', 'checkout-api 5xx errors above 5%', 3, now() - interval '25 minutes' FROM sc
                RETURNING id, team_id),
         i2 AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title, opened_at)
                SELECT id, team_id, 'seed-2', 'SEV4', 'ledger disk 80% full', now() - interval '3 hours' FROM sl
                RETURNING id, team_id),
         i3 AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title, opened_at)
                SELECT id, team_id, 'seed-3', 'SEV1', 'search-api down in eu-west-2', now() - interval '10 minutes' FROM ss
                RETURNING id, team_id)
    INSERT INTO incident_events (incident_id, team_id, kind)
    SELECT id, team_id, 'alert_received' FROM i1
    UNION ALL SELECT id, team_id, 'alert_received' FROM i2
    UNION ALL SELECT id, team_id, 'alert_received' FROM i3`);
  console.log(JSON.stringify({ event: "seed_done", teams: 2, users: 3, incidents: 3 }));
  return true;
}

/**
 * Demo seed only: sets the password of seeded users that have none, writing
 * the hash directly (the caller runs as the table owner). Returns the count.
 */
export async function setDemoPasswords(client: ClientBase, password: string): Promise<number> {
  let count = 0;
  for (const email of DEMO_EMAILS) {
    const hash = await hashPassword(password);
    const { rowCount } = await client.query("UPDATE users SET password_hash = $2 WHERE lower(email) = $1 AND password_hash IS NULL", [email, hash]);
    count += rowCount ?? 0;
  }
  return count;
}
