import type { ClientBase } from "pg";

// Human decisions about messages the worker could not deliver with certainty
// (CLAUDE.md: a step that cannot be safely repeated is flagged for a person).
// Callers run as app_rw: RLS shows these only to the team's admins.

export interface ReviewItem {
  id: string;
  caseNumber: string;
  incidentId: string;
  incidentTitle: string;
  kind: string;
  /** Recipient address: admins cannot read other users' profiles, the message carries the address. */
  recipient: string;
  status: string;
  attempts: number;
  reason: string | null;
  createdAt: Date;
}

export type ReviewDecision = "confirm_sent" | "send_again" | "dismiss";

export async function listForReview(db: ClientBase): Promise<ReviewItem[]> {
  const { rows } = await db.query<ReviewItem>(
    `SELECT n.id::text AS id, 'INC-' || i.number AS "caseNumber", i.id AS "incidentId", i.title AS "incidentTitle",
            n.kind, n.recipient_email AS recipient, n.status, n.attempts, n.last_error_code AS reason, n.created_at AS "createdAt"
     FROM notifications n JOIN incidents i ON i.id = n.incident_id
     WHERE n.status IN ('needs_review', 'failed')
     ORDER BY (n.status = 'needs_review') DESC, n.created_at`,
  );
  return rows;
}

const NEXT_STATUS: Record<ReviewDecision, string> = {
  confirm_sent: "sent", // a person checked that it arrived
  send_again: "pending", // a person decided resending is safe
  dismiss: "dismissed", // a person decided it is no longer needed
};

export async function reviewNotification(
  db: ClientBase,
  { notificationId, decision, actor }: { notificationId: string; decision: ReviewDecision; actor: { id: string; name: string } },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^\d{1,18}$/.test(notificationId) || !(decision in NEXT_STATUS)) return { ok: false, error: "not_found" };
  const { rows } = await db.query<{ team_id: string }>(
    `UPDATE notifications SET status = $2, reviewed_by = $3, reviewed_at = now(), next_attempt_at = now()
     WHERE id = $1 AND status IN ('needs_review', 'failed')
     RETURNING team_id`,
    [notificationId, NEXT_STATUS[decision], actor.id],
  );
  const updated = rows[0];
  if (!updated) return { ok: false, error: "not_found" };
  await db.query(
    `INSERT INTO audit_log (actor_user_id, team_id, action, entity_type, entity_id) VALUES ($1, $2, $3, 'notification', $4)`,
    [actor.id, updated.team_id, `notification.${decision}`, notificationId],
  );
  return { ok: true };
}

/** The incident's current SLA targets (latest timer of each kind). */
export async function getSla(db: ClientBase, incidentId: string): Promise<{ ackDue: Date | null; resolveDue: Date | null; escalated: boolean }> {
  const { rows } = await db.query<{ kind: string; wake_at: Date; fired: boolean }>(
    `SELECT kind, wake_at, fired_at IS NOT NULL AS fired FROM timers WHERE incident_id = $1 ORDER BY id`,
    [incidentId],
  );
  const latest = (kind: string) => rows.filter((r) => r.kind === kind).at(-1);
  return {
    ackDue: latest("ack_due")?.wake_at ?? null,
    resolveDue: latest("resolve_due")?.wake_at ?? null,
    escalated: rows.some((r) => r.kind === "ack_due" && r.fired),
  };
}
