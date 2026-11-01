import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedAlert } from "../../src/ingest/cloudwatch.ts";
import { findSnsIntegration, ingestAlert } from "../../src/ingest/store.ts";
import { connect, inRollback } from "./helpers.ts";

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

const TOPIC = "arn:aws:sns:eu-west-2:123456789012:alerts";

function alert(overrides: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    source: "cloudwatch",
    externalId: randomUUID(),
    fingerprint: "f".repeat(64),
    status: "firing",
    severity: "SEV2",
    title: "checkout-api-5xx",
    summary: "Threshold crossed",
    occurredAt: new Date("2026-11-01T09:00:00Z"),
    ...overrides,
  };
}

// Seeds as owner, then acts as the ingest role for the rest of the transaction.
async function seedAsIngest(): Promise<{ integrationId: string; teamId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const { rows } = await client.query(
    `WITH t AS (INSERT INTO teams (name) VALUES ($1) RETURNING id),
          s AS (INSERT INTO services (team_id, name) SELECT id, 'checkout' FROM t RETURNING id),
          i AS (INSERT INTO integrations (service_id, kind, sns_topic_arn) SELECT id, 'sns', $2 FROM s RETURNING id)
     SELECT (SELECT id FROM i) AS "integrationId", (SELECT id FROM t) AS "teamId"`,
    [`team-${suffix}`, TOPIC],
  );
  await client.query("SET LOCAL ROLE app_ingest");
  return rows[0];
}

async function ingest(integrationId: string, a: NormalizedAlert) {
  const integration = await findSnsIntegration(client, integrationId);
  if (!integration) throw new Error("integration not found");
  return ingestAlert(client, integration, a, { raw: true });
}

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("RESET ROLE");
  try {
    return await fn();
  } finally {
    await client.query("SET LOCAL ROLE app_ingest");
  }
}

describe("findSnsIntegration", () => {
  it("returns the active SNS integration with its service, team and topic", async () => {
    await inRollback(client, async () => {
      const { integrationId, teamId } = await seedAsIngest();
      expect(await findSnsIntegration(client, integrationId)).toEqual({
        id: integrationId,
        serviceId: expect.any(String),
        teamId,
        topicArn: TOPIC,
      });
    });
  });

  it("returns null for an unknown id or a non-UUID", async () => {
    await inRollback(client, async () => {
      await seedAsIngest();
      expect(await findSnsIntegration(client, randomUUID())).toBeNull();
      expect(await findSnsIntegration(client, "not-a-uuid")).toBeNull();
    });
  });
});

describe("ingestAlert", () => {
  it("opens an incident for a new firing alert, with a timeline entry and an audit row", async () => {
    await inRollback(client, async () => {
      const { integrationId, teamId } = await seedAsIngest();
      const outcome = await ingest(integrationId, alert());
      expect(outcome).toEqual({ kind: "incident_opened", incidentId: expect.any(String) });

      const incidentId = (outcome as { incidentId: string }).incidentId;
      const rows = await asOwner(async () => ({
        incident: (await client.query("SELECT team_id, status, severity, title, alert_count FROM incidents WHERE id = $1", [incidentId])).rows,
        events: (await client.query("SELECT kind FROM incident_events WHERE incident_id = $1", [incidentId])).rows,
        audit: (await client.query("SELECT action FROM audit_log WHERE entity_id = $1", [incidentId])).rows,
      }));
      expect(rows.incident).toEqual([{ team_id: teamId, status: "triggered", severity: "SEV2", title: "checkout-api-5xx", alert_count: 1 }]);
      expect(rows.events).toEqual([{ kind: "alert_received" }]);
      expect(rows.audit).toEqual([{ action: "incident.opened" }]);
    });
  });

  it("adds a repeat alert to the open incident instead of opening a second one", async () => {
    await inRollback(client, async () => {
      const { integrationId, teamId } = await seedAsIngest();
      const first = await ingest(integrationId, alert());
      const second = await ingest(integrationId, alert());
      expect(second).toEqual({ kind: "incident_updated", incidentId: (first as { incidentId: string }).incidentId, alertCount: 2 });
      const count = await asOwner(async () => (await client.query("SELECT count(*)::int AS n FROM incidents WHERE team_id = $1", [teamId])).rows[0].n);
      expect(count).toBe(1);
    });
  });

  it("treats a re-delivery of the same message as a no-op", async () => {
    await inRollback(client, async () => {
      const { integrationId, teamId } = await seedAsIngest();
      const a = alert();
      await ingest(integrationId, a);
      expect(await ingest(integrationId, a)).toEqual({ kind: "duplicate_delivery" });
      const counts = await asOwner(async () => (await client.query("SELECT alert_count FROM incidents WHERE team_id = $1", [teamId])).rows);
      expect(counts).toEqual([{ alert_count: 1 }]);
    });
  });

  it("records a cleared alarm on the open incident without resolving it", async () => {
    await inRollback(client, async () => {
      const { integrationId } = await seedAsIngest();
      const opened = (await ingest(integrationId, alert())) as { incidentId: string };
      expect(await ingest(integrationId, alert({ status: "resolved" }))).toEqual({ kind: "alert_cleared", incidentId: opened.incidentId });
      const state = await asOwner(async () => ({
        status: (await client.query("SELECT status FROM incidents WHERE id = $1", [opened.incidentId])).rows[0].status,
        events: (await client.query("SELECT kind FROM incident_events WHERE incident_id = $1 ORDER BY id", [opened.incidentId])).rows,
      }));
      expect(state).toEqual({ status: "triggered", events: [{ kind: "alert_received" }, { kind: "alert_resolved" }] });
    });
  });

  it("stores a cleared alarm with no open incident without creating one", async () => {
    await inRollback(client, async () => {
      const { integrationId, teamId } = await seedAsIngest();
      expect(await ingest(integrationId, alert({ status: "resolved" }))).toEqual({ kind: "cleared_without_incident" });
      const count = await asOwner(async () => (await client.query("SELECT count(*)::int AS n FROM incidents WHERE team_id = $1", [teamId])).rows[0].n);
      expect(count).toBe(0);
    });
  });

  it("opens a new incident when the previous one for the same alarm was resolved", async () => {
    await inRollback(client, async () => {
      const { integrationId } = await seedAsIngest();
      const first = (await ingest(integrationId, alert())) as { incidentId: string };
      await asOwner(() => client.query("UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = $1", [first.incidentId]));
      const second = await ingest(integrationId, alert());
      expect(second).toEqual({ kind: "incident_opened", incidentId: expect.any(String) });
      expect((second as { incidentId: string }).incidentId).not.toBe(first.incidentId);
    });
  });
});
