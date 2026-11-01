// Incident status rules: forward only, steps may be skipped, resolved is final.
// The database (RLS) decides WHO may change status; this decides WHICH changes are valid.

export const STATUSES = ["triggered", "acknowledged", "mitigated", "resolved"] as const;
export type IncidentStatus = (typeof STATUSES)[number];

type TimestampColumn = "acknowledged_at" | "mitigated_at" | "resolved_at";

const TIMESTAMP_FOR: Record<Exclude<IncidentStatus, "triggered">, TimestampColumn> = {
  acknowledged: "acknowledged_at",
  mitigated: "mitigated_at",
  resolved: "resolved_at",
};

export function isStatus(value: string): value is IncidentStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export function allowedNextStatuses(from: IncidentStatus): IncidentStatus[] {
  return STATUSES.slice(STATUSES.indexOf(from) + 1);
}

export type TransitionPlan =
  | { ok: true; status: IncidentStatus; set: Partial<Record<TimestampColumn, Date>> }
  | { ok: false; error: string };

export function planTransition(from: IncidentStatus, to: string, now: Date): TransitionPlan {
  if (!isStatus(to)) return { ok: false, error: "unknown status" };
  if (to === "triggered" || !allowedNextStatuses(from).includes(to)) {
    return { ok: false, error: `cannot move from ${from} to ${to}` };
  }
  return { ok: true, status: to, set: { [TIMESTAMP_FOR[to]]: now } };
}
