import type { ClientBase } from "pg";
import { toCsv } from "./csv.ts";

// Audit trail for team admins (RLS: app_rw sees only rows of teams it administers).
// Exports are themselves audited (SPEC behaviour 6: every change and every export).

export interface AuditEntry {
  occurredAt: Date;
  team: string | null;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
}

const MAX_EXPORT = 50_000;

async function query(db: ClientBase, limit: number): Promise<AuditEntry[]> {
  const { rows } = await db.query<AuditEntry>(
    `SELECT a.occurred_at AS "occurredAt", t.name AS team, a.action, a.entity_type AS "entityType",
            a.entity_id AS "entityId", a.actor_user_id AS "actorUserId"
     FROM audit_log a LEFT JOIN teams t ON t.id = a.team_id
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function listAudit(db: ClientBase, { limit }: { limit: number }): Promise<AuditEntry[]> {
  return query(db, Math.min(Math.max(limit, 1), 500));
}

export async function exportAudit(
  db: ClientBase,
  { actor, now }: { actor: { id: string; name: string }; now: Date },
): Promise<{ csv: string; count: number }> {
  const admin = await db.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = app_user_id() AND role = 'admin') AS ok",
  );
  if (!admin.rows[0]?.ok) throw new Error("not an admin of any team");

  const entries = await query(db, MAX_EXPORT);
  const csv = toCsv(
    ["occurred_at", "team", "action", "entity_type", "entity_id", "actor_user_id"],
    entries.map((e) => [e.occurredAt.toISOString(), e.team, e.action, e.entityType, e.entityId, e.actorUserId]),
  );
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, occurred_at) VALUES ($1, 'audit.exported', 'audit_export', $2, $3)`,
    [actor.id, `${entries.length} rows`, now],
  );
  return { csv, count: entries.length };
}
