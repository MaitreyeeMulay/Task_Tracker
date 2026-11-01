import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import fixture from "../../src/ingest/fixtures/sns-cloudwatch-alarm.json" with { type: "json" };
import { snsStringToSign, type SnsMessage } from "../../src/ingest/sns.ts";
import { createSnsDeps } from "../../src/ingest/sns-deps.ts";
import { handleSnsIngest } from "../../src/ingest/sns-handler.ts";

// M1 "done when": a sample alert creates an incident, a duplicate does not,
// and a forged signature is rejected. Real handler, real verification, real
// Postgres; only the certificate download is replaced by a local test key.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

let pool: pg.Pool;
let integrationId: string;
let teamId: string;
let topicArn: string;
const logs: Record<string, unknown>[] = [];

function signedAlarm(messageId: string, change: Record<string, unknown> = {}): string {
  const message = JSON.stringify({ ...JSON.parse(fixture.Message), ...change });
  const unsigned = { ...fixture, MessageId: messageId, TopicArn: topicArn, Message: message } as SnsMessage;
  const Signature = createSign("RSA-SHA256").update(snsStringToSign(unsigned)).sign(privateKey, "base64");
  return JSON.stringify({ ...unsigned, Signature });
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("testDatabaseUrl"), max: 4 });
  // Unique alarm per run, so committed rows from earlier runs never collide.
  topicArn = `arn:aws:sns:eu-west-2:123456789012:e2e-${randomUUID().slice(0, 8)}`;
  const { rows } = await pool.query(
    `WITH t AS (INSERT INTO teams (name) VALUES ($1) RETURNING id),
          s AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM t RETURNING id),
          i AS (INSERT INTO integrations (service_id, kind, sns_topic_arn) SELECT id, 'sns', $2 FROM s RETURNING id)
     SELECT (SELECT id FROM i) AS "integrationId", (SELECT id FROM t) AS "teamId"`,
    [`e2e-${randomUUID().slice(0, 8)}`, topicArn],
  );
  ({ integrationId, teamId } = rows[0]);
});

afterAll(async () => {
  await pool.end();
});

const deps = () =>
  createSnsDeps({
    pool,
    fetchCert: async () => PUBLIC_PEM,
    confirmSubscription: async () => {},
    log: (event) => logs.push(event),
  });

async function incidentsForTeam() {
  return (await pool.query("SELECT id, alert_count FROM incidents WHERE team_id = $1", [teamId])).rows;
}

describe("SNS ingestion end to end", () => {
  it("a sample alert creates an incident", async () => {
    const result = await handleSnsIngest({ integrationId, body: signedAlarm(randomUUID()) }, deps());
    expect(result.status).toBe(201);
    expect(await incidentsForTeam()).toEqual([{ id: result.body.incidentId, alert_count: 1 }]);
  });

  it("a duplicate alert does not create a second incident", async () => {
    const result = await handleSnsIngest({ integrationId, body: signedAlarm(randomUUID()) }, deps());
    expect(result).toMatchObject({ status: 200, body: { result: "incident_updated" } });
    expect(await incidentsForTeam()).toEqual([{ id: expect.any(String), alert_count: 2 }]);
  });

  it("a re-delivered message changes nothing", async () => {
    const body = signedAlarm(randomUUID());
    await handleSnsIngest({ integrationId, body }, deps());
    expect((await handleSnsIngest({ integrationId, body }, deps())).body).toEqual({ result: "duplicate_delivery" });
    expect(await incidentsForTeam()).toEqual([{ id: expect.any(String), alert_count: 3 }]);
  });

  it("a forged signature is rejected and nothing is stored", async () => {
    const forged = JSON.parse(signedAlarm(randomUUID()));
    forged.Message = forged.Message.replace("checkout-api-5xx", "forged-alarm");
    const before = (await pool.query("SELECT count(*)::int AS n FROM alerts WHERE integration_id = $1", [integrationId])).rows[0].n;
    expect(await handleSnsIngest({ integrationId, body: JSON.stringify(forged) }, deps())).toEqual({ status: 403, body: { error: "forbidden" } });
    const after = (await pool.query("SELECT count(*)::int AS n FROM alerts WHERE integration_id = $1", [integrationId])).rows[0].n;
    expect(after).toBe(before);
  });

  it("logs ids and outcomes only, never payload content", () => {
    const text = JSON.stringify(logs);
    expect(text).not.toContain("Threshold Crossed");
    expect(text).not.toContain("checkout-api-5xx");
  });
});
