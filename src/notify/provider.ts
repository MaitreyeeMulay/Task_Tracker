import type { SendResult } from "../worker/policy.ts";

// Email goes through this interface (CLAUDE.md: external calls behind an
// interface with a stub for development). The AWS SES provider is in ses.ts;
// the worker picks it with EMAIL_PROVIDER=ses.

export interface EmailMessage {
  notificationId: string;
  incidentId: string;
  to: string;
  subject: string;
  text: string;
}

export type EmailProvider = (message: EmailMessage) => Promise<SendResult>;

/** Development stub: records messages in memory, logs ids only (never addresses or text). */
export function createStubProvider(): { provider: EmailProvider; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = async (message) => {
    sent.push(message);
    console.log(JSON.stringify({ event: "stub_email_sent", notification_id: message.notificationId, incident_id: message.incidentId }));
    return { outcome: "delivered", messageId: `stub-${message.notificationId}` };
  };
  return { provider, sent };
}
