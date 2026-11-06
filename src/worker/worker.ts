import type { Pool, PoolClient } from "pg";
import { formatCaseNumber } from "../incidents/case-number.ts";
import type { EmailProvider } from "../notify/provider.ts";
import { afterSendAttempt, type SendResult } from "./policy.ts";

// The background worker (M4). Every step is one short transaction as app_worker.
//
//  fireDueTimers  claims one due timer (FOR UPDATE SKIP LOCKED), writes its
//                 notifications and timeline entry, marks it fired, commits.
//                 A crash before COMMIT rolls everything back, so the timer
//                 simply fires after restart. The outbox unique key means a
//                 timer can never produce the same message twice.
//  sendPending    claims one message (status 'sending', committed BEFORE the
//                 provider call), sends, then records the result.
//  sweepStaleSends a message stuck in 'sending' past the lease means a worker
//                 died mid-send: it may or may not have gone out, so it is
//                 marked 'needs_review' for a person, never resent (CLAUDE.md).

async function inWorkerTransaction<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE app_worker");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } finally {
    db.release();
  }
}

type TimerKind = "notify_open" | "ack_due" | "resolve_due";

const PLAN: Record<TimerKind, { kind: string; level: 1 | 2; roles: string[] }> = {
  notify_open: { kind: "incident_opened", level: 1, roles: ["responder", "admin"] },
  ack_due: { kind: "ack_overdue", level: 2, roles: ["admin"] },
  resolve_due: { kind: "resolve_overdue", level: 1, roles: ["responder", "admin"] },
};

/** Fires at most one due timer. Returns 1 if one was handled, 0 if none was due. */
export async function fireDueTimers(
  pool: Pool,
  { now, onlyIncidentId, beforeCommit }: { now: Date; onlyIncidentId?: string; beforeCommit?: () => Promise<void> },
): Promise<number> {
  return inWorkerTransaction(pool, async (db) => {
    const due = await db.query<{ id: string; incident_id: string; team_id: string; kind: TimerKind }>(
      `SELECT id, incident_id, team_id, kind FROM timers
       WHERE wake_at <= $1 AND fired_at IS NULL AND cancelled_at IS NULL
         AND ($2::uuid IS NULL OR incident_id = $2)
       ORDER BY wake_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [now, onlyIncidentId ?? null],
    );
    const timer = due.rows[0];
    if (!timer) return 0;

    const incident = (
      await db.query<{ number: string; title: string; severity: string; status: string; service: string; ack_minutes: number; resolve_minutes: number }>(
        `SELECT i.number, i.title, i.severity, i.status, s.name AS service, t.ack_minutes, t.resolve_minutes
         FROM incidents i JOIN services s ON s.id = i.service_id JOIN sla_targets t ON t.severity = i.severity
         WHERE i.id = $1`,
        [timer.incident_id],
      )
    ).rows[0];

    // Guard: the incident moved on since the timer was scheduled.
    const stale =
      !incident ||
      (timer.kind === "ack_due" && incident.status !== "triggered") ||
      (timer.kind === "resolve_due" && incident.status === "resolved");
    if (!stale && incident) {
      const plan = PLAN[timer.kind];
      let recipients = await db.query<{ user_id: string; email: string }>(
        `SELECT m.user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND m.role = ANY($2)`,
        [timer.team_id, plan.roles],
      );
      // No admins to escalate to: fall back to responders rather than tell nobody.
      if (recipients.rows.length === 0 && timer.kind === "ack_due") {
        recipients = await db.query(
          `SELECT m.user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.team_id = $1 AND m.role = 'responder'`,
          [timer.team_id],
        );
      }

      const ref = formatCaseNumber(Number(incident.number));
      const headline = {
        notify_open: `[${incident.severity}] ${ref} opened: ${incident.title}`,
        ack_due: `[${incident.severity}] ${ref} NOT ACKNOWLEDGED: ${incident.title}`,
        resolve_due: `[${incident.severity}] ${ref} past its resolve target: ${incident.title}`,
      }[timer.kind];
      const body = `${headline}\nService: ${incident.service}\nStatus: ${incident.status}\nOpen the incident tracker and search for ${ref}.`;

      for (const r of recipients.rows) {
        await db.query(
          `INSERT INTO notifications (incident_id, team_id, kind, level, recipient_user_id, recipient_email, subject, body, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (incident_id, kind, level, recipient_user_id) DO NOTHING`,
          [timer.incident_id, timer.team_id, plan.kind, plan.level, r.user_id, r.email, headline.slice(0, 300), body, now],
        );
      }

      if (timer.kind === "ack_due") {
        await db.query(`INSERT INTO incident_events (incident_id, team_id, kind, data) VALUES ($1, $2, 'escalated', $3)`, [
          timer.incident_id,
          timer.team_id,
          JSON.stringify({ text: `Not acknowledged within ${incident.ack_minutes} min (${incident.severity}): escalated to team admins` }),
        ]);
      } else if (timer.kind === "resolve_due") {
        await db.query(`INSERT INTO incident_events (incident_id, team_id, kind, data) VALUES ($1, $2, 'sla_breached', $3)`, [
          timer.incident_id,
          timer.team_id,
          JSON.stringify({ text: `Not resolved within ${incident.resolve_minutes} min (${incident.severity})` }),
        ]);
      }
    }

    await db.query(stale ? "UPDATE timers SET cancelled_at = $2 WHERE id = $1" : "UPDATE timers SET fired_at = $2 WHERE id = $1", [timer.id, now]);
    if (beforeCommit) await beforeCommit();
    console.log(JSON.stringify({ event: stale ? "timer_skipped" : "timer_fired", timer_id: timer.id, kind: timer.kind }));
    return 1;
  });
}

/** Sends at most one pending message. Returns 1 if one was attempted, 0 if none was ready. */
export async function sendPending(
  pool: Pool,
  provider: EmailProvider,
  { now, workerId, onlyIncidentId }: { now: Date; workerId: string; onlyIncidentId?: string },
): Promise<number> {
  // 1. Claim, and commit the claim before talking to the provider.
  const claimed = await inWorkerTransaction(pool, async (db) => {
    const { rows } = await db.query<{ id: string; incident_id: string; recipient_email: string; subject: string; body: string; attempts: number }>(
      `UPDATE notifications SET status = 'sending', claimed_at = $1, claimed_by = $2, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM notifications
         WHERE status = 'pending' AND next_attempt_at <= $1 AND ($3::uuid IS NULL OR incident_id = $3)
         ORDER BY next_attempt_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING id, incident_id, recipient_email, subject, body, attempts`,
      [now, workerId, onlyIncidentId ?? null],
    );
    return rows[0];
  });
  if (!claimed) return 0;

  // 2. Send. An exception here is an ambiguous outcome: it may have gone out.
  let result: SendResult;
  try {
    result = await provider({
      notificationId: claimed.id,
      incidentId: claimed.incident_id,
      to: claimed.recipient_email,
      subject: claimed.subject,
      text: claimed.body,
    });
  } catch {
    result = { outcome: "unknown", code: "provider_exception" };
  }

  // 3. Record the result, only if this worker still holds the claim.
  const next = afterSendAttempt(result, claimed.attempts, now);
  await inWorkerTransaction(pool, (db) =>
    db.query(
      `UPDATE notifications SET
         status = $3,
         sent_at = CASE WHEN $3 = 'sent' THEN $4::timestamptz ELSE sent_at END,
         provider_message_id = coalesce($5, provider_message_id),
         next_attempt_at = coalesce($6, next_attempt_at),
         last_error_code = $7
       WHERE id = $1 AND status = 'sending' AND claimed_by = $2`,
      [
        claimed.id,
        workerId,
        next.status,
        now,
        next.status === "sent" ? next.messageId.slice(0, 200) : null,
        next.status === "pending" ? next.retryAt : null,
        next.status === "sent" ? null : next.code.slice(0, 100),
      ],
    ),
  );
  console.log(JSON.stringify({ event: "notification_attempt", notification_id: claimed.id, attempt: claimed.attempts, status: next.status }));
  return 1;
}

/** Messages stuck in 'sending' longer than the lease: flag for a person, never resend. */
export async function sweepStaleSends(pool: Pool, { now, leaseMs }: { now: Date; leaseMs: number }): Promise<number> {
  return inWorkerTransaction(pool, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE notifications SET status = 'needs_review', last_error_code = 'worker_lost_mid_send'
       WHERE status = 'sending' AND claimed_at < $1`,
      [new Date(now.getTime() - leaseMs)],
    );
    if (rowCount) console.log(JSON.stringify({ event: "notifications_flagged_for_review", count: rowCount }));
    return rowCount ?? 0;
  });
}

export async function heartbeat(pool: Pool, workerId: string, now: Date): Promise<void> {
  await inWorkerTransaction(pool, (db) =>
    db.query(
      `INSERT INTO worker_heartbeats (worker_id, seen_at) VALUES ($1, $2)
       ON CONFLICT (worker_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
      [workerId, now],
    ),
  );
}

const BATCH = 50;

/** One worker pass: recover stale sends, fire due timers, send pending mail. */
export async function runOnce(
  pool: Pool,
  provider: EmailProvider,
  { now, workerId, leaseMs }: { now: Date; workerId: string; leaseMs: number },
): Promise<{ flagged: number; fired: number; sent: number }> {
  const flagged = await sweepStaleSends(pool, { now, leaseMs });
  let fired = 0;
  while (fired < BATCH && (await fireDueTimers(pool, { now })) > 0) fired++;
  let sent = 0;
  while (sent < BATCH && (await sendPending(pool, provider, { now, workerId })) > 0) sent++;
  await heartbeat(pool, workerId, now);
  return { flagged, fired, sent };
}
