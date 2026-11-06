import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUserInTransaction } from "../../src/db/with-user.ts";
import { getSla, listForReview, reviewNotification } from "../../src/notify/review.ts";
import { connect, inRollback } from "./helpers.ts";

// Messages the worker could not deliver with certainty wait for a person.
// Only the team's admins see them and decide; every decision is audited.

let client: pg.Client;
const T0 = new Date("2026-11-08T10:00:00Z");

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

type World = Record<"admin" | "responder" | "incident" | "flagged" | "failed" | "pending", string>;

async function seed(): Promise<World> {
  const { rows } = await client.query(
    `WITH t AS (INSERT INTO teams (name) VALUES ('nr-team') RETURNING id),
          a AS (INSERT INTO users (email, display_name) VALUES ('admin@nr.test', 'Ada') RETURNING id),
          r AS (INSERT INTO users (email, display_name) VALUES ('resp@nr.test', 'Rex') RETURNING id),
          m AS (INSERT INTO memberships (team_id, user_id, role)
                SELECT (SELECT id FROM t), (SELECT id FROM a), 'admin'
                UNION ALL SELECT (SELECT id FROM t), (SELECT id FROM r), 'responder'),
          s AS (INSERT INTO services (team_id, name) SELECT id, 'api' FROM t RETURNING id, team_id),
          i AS (INSERT INTO incidents (service_id, team_id, fingerprint, severity, title, opened_at)
                SELECT id, team_id, 'nr', 'SEV2', 'API errors', $1 FROM s RETURNING id, team_id),
          n AS (INSERT INTO notifications (incident_id, team_id, kind, level, recipient_user_id, recipient_email, subject, body, status, attempts, last_error_code)
                SELECT i.id, i.team_id, k.kind, 1, (SELECT id FROM r), 'resp@nr.test', 'subj', 'body', k.status, 1, k.code
                FROM i, (VALUES ('incident_opened', 'needs_review', 'worker_lost_mid_send'),
                                ('resolve_overdue', 'failed', 'InvalidAddress'),
                                ('ack_overdue', 'pending', NULL)) AS k(kind, status, code)
                RETURNING id, status)
     SELECT (SELECT id FROM a) AS admin, (SELECT id FROM r) AS responder, (SELECT id FROM i) AS incident,
            (SELECT id::text FROM n WHERE status = 'needs_review') AS flagged,
            (SELECT id::text FROM n WHERE status = 'failed') AS failed,
            (SELECT id::text FROM n WHERE status = 'pending') AS pending`,
    [T0],
  );
  return rows[0];
}

const ada = (w: World) => ({ id: w.admin, name: "Ada" });

describe("reviewing notifications", () => {
  it("admins see their team's messages that need a person, with the reason", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.admin);
      const items = await listForReview(client);
      expect(items.map((n) => [n.status, n.kind, n.recipient, n.reason])).toEqual([
        ["needs_review", "incident_opened", "resp@nr.test", "worker_lost_mid_send"],
        ["failed", "resolve_overdue", "resp@nr.test", "InvalidAddress"],
      ]);
      expect(items[0]?.caseNumber).toMatch(/^INC-\d+$/);
    });
  });

  it("responders see nothing to review", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.responder);
      expect(await listForReview(client)).toEqual([]);
    });
  });

  it.each([
    ["confirm_sent", "sent"],
    ["send_again", "pending"],
    ["dismiss", "dismissed"],
  ] as const)("%s sets the message to %s and is audited", async (decision, status) => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.admin);
      expect(await reviewNotification(client, { notificationId: w.flagged, decision, actor: ada(w) })).toEqual({ ok: true });
      await client.query("RESET ROLE");
      const row = (await client.query("SELECT status, reviewed_by FROM notifications WHERE id = $1", [w.flagged])).rows[0];
      expect(row).toEqual({ status, reviewed_by: w.admin });
      const audit = await client.query("SELECT action FROM audit_log WHERE entity_type = 'notification' AND entity_id = $1", [w.flagged]);
      expect(audit.rows).toEqual([{ action: `notification.${decision}` }]);
    });
  });

  it("cannot touch a message that is not waiting for review", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.admin);
      expect(await reviewNotification(client, { notificationId: w.pending, decision: "dismiss", actor: ada(w) })).toEqual({ ok: false, error: "not_found" });
    });
  });

  it("a responder cannot review", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.responder);
      expect(await reviewNotification(client, { notificationId: w.flagged, decision: "send_again", actor: { id: w.responder, name: "Rex" } })).toEqual({
        ok: false,
        error: "not_found",
      });
    });
  });
});

describe("getSla", () => {
  it("shows when the incident must be acknowledged and resolved", async () => {
    await inRollback(client, async () => {
      const w = await seed();
      await asUserInTransaction(client, w.responder);
      expect(await getSla(client, w.incident)).toEqual({
        ackDue: new Date("2026-11-08T10:15:00Z"),
        resolveDue: new Date("2026-11-08T14:00:00Z"),
        escalated: false,
      });
    });
  });
});
