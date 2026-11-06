export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";
export type SlaTargets = Record<Severity, { ackMinutes: number; resolveMinutes: number }>;

export const DEFAULT_SLA: SlaTargets = {
  SEV1: { ackMinutes: 5, resolveMinutes: 60 },
  SEV2: { ackMinutes: 15, resolveMinutes: 240 },
  SEV3: { ackMinutes: 60, resolveMinutes: 1440 },
  SEV4: { ackMinutes: 240, resolveMinutes: 4320 },
};

export function slaDueTimes(severity: Severity, openedAt: Date, targets: SlaTargets): { ackDue: Date; resolveDue: Date } {
  const { ackMinutes, resolveMinutes } = targets[severity];
  const at = (minutes: number) => new Date(openedAt.getTime() + minutes * 60_000);
  return { ackDue: at(ackMinutes), resolveDue: at(resolveMinutes) };
}

export type SendResult =
  | { outcome: "delivered"; messageId: string }
  | { outcome: "rejected"; code: string; permanent?: boolean }
  | { outcome: "unknown"; code: string };

export type NextState =
  | { status: "sent"; messageId: string }
  | { status: "pending"; retryAt: Date; code: string }
  | { status: "failed"; code: string }
  | { status: "needs_review"; code: string };

const MAX_ATTEMPTS = 4;
const BACKOFF_MINUTES = [1, 5, 25];

/**
 * Decides an outbox message's next state after one send attempt.
 * Only a definite, temporary rejection is retried. An ambiguous result (for
 * example a timeout after the request left) may already have been delivered,
 * so it goes to a person instead (CLAUDE.md: never auto-retry what can't be
 * safely repeated).
 */
export function afterSendAttempt(result: SendResult, attempt: number, now: Date): NextState {
  if (result.outcome === "delivered") return { status: "sent", messageId: result.messageId };
  if (result.outcome === "unknown") return { status: "needs_review", code: result.code };
  if (result.permanent || attempt >= MAX_ATTEMPTS) return { status: "failed", code: result.code };
  const minutes = BACKOFF_MINUTES[attempt - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1] ?? 25;
  return { status: "pending", retryAt: new Date(now.getTime() + minutes * 60_000), code: result.code };
}
