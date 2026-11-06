import Link from "next/link";
import { requireUser } from "@/auth/current-user";
import { withUser } from "@/db/with-user";
import { getPool } from "@/lib/db";
import { listForReview } from "@/notify/review";
import { reviewAction } from "./actions";

export const dynamic = "force-dynamic";

const KIND: Record<string, string> = {
  incident_opened: "Incident opened",
  ack_overdue: "Escalation (not acknowledged)",
  resolve_overdue: "Resolve target missed",
};

const REASON: Record<string, string> = {
  worker_lost_mid_send: "The worker stopped while sending. It may or may not have arrived.",
  provider_exception: "The email service did not answer clearly. It may or may not have arrived.",
  Timeout: "The email service timed out. It may or may not have arrived.",
};

const fmt = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await requireUser();
  const items = await withUser(getPool(), user.id, (db) => listForReview(db));

  return (
    <main className="stack">
      <h1>Notifications to review</h1>
      <p className="muted">
        Emails the system could not deliver with certainty. They are never resent automatically, because that could notify someone
        twice. Decide for each one. Only team admins see this list.
      </p>
      {error ? <p role="alert" className="error">That message is no longer waiting for review.</p> : null}
      {items.length === 0 ? <p className="muted">Nothing to review.</p> : null}
      {items.map((n) => (
        <div key={n.id} className="card stack">
          <div className="row">
            <span className={`badge ${n.status === "needs_review" ? "sev-sev3" : "sev-sev1"}`}>{n.status === "needs_review" ? "needs review" : "failed"}</span>
            <strong>{KIND[n.kind] ?? n.kind}</strong>
            <span className="muted">
              <Link href={`/incidents/${n.incidentId}`}>{n.caseNumber}</Link> {n.incidentTitle}
            </span>
          </div>
          <p className="muted small">
            To {n.recipient} · {n.attempts} attempt{n.attempts === 1 ? "" : "s"} · {fmt(n.createdAt)}
            <br />
            {n.reason ? (REASON[n.reason] ?? `Rejected by the email service (${n.reason}).`) : null}
          </p>
          <div className="row">
            {(
              [
                ["confirm_sent", "It arrived"],
                ["send_again", "Send again"],
                ["dismiss", "Dismiss"],
              ] as const
            ).map(([decision, label]) => (
              <form key={decision} action={reviewAction}>
                <input type="hidden" name="notificationId" value={n.id} />
                <input type="hidden" name="decision" value={decision} />
                <button type="submit" className={decision === "send_again" ? undefined : "secondary"}>
                  {label}
                </button>
              </form>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
