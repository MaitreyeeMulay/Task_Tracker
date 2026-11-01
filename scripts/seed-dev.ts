// Usage: npm run seed  (development data in DATABASE_URL; safe to run twice)
// Refuses to run when NODE_ENV=production.
import pg from "pg";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("refusing to seed in production");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set. See .env.example.");

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM users WHERE lower(email) = 'alice@example.test'");
    if (existing.rowCount) {
      console.log(JSON.stringify({ event: "seed_skipped", reason: "already seeded" }));
      return;
    }
    await client.query("BEGIN");
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
    await client.query("COMMIT");
    console.log(JSON.stringify({ event: "seed_done", teams: 2, users: 3, incidents: 3 }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "seed_failed", message: (error as Error).message }));
  process.exit(1);
});
