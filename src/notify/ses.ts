import type { SendResult } from "../worker/policy.ts";
import type { EmailMessage, EmailProvider } from "./provider.ts";

// AWS SES behind the EmailProvider interface. The SDK client is passed in as
// `send`, so this file has no AWS dependency and is unit tested; the adapter
// in src/lib/aws.ts builds the real one with SDK retries turned off.

/** Shape of SESv2 SendEmail input and output, limited to what we use. */
export interface SesSendInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: { Simple: { Subject: { Data: string; Charset: "UTF-8" }; Body: { Text: { Data: string; Charset: "UTF-8" } } } };
}
export type SesSend = (input: SesSendInput) => Promise<{ MessageId?: string | undefined }>;

// SES refused these before accepting the message, so a later retry is safe.
const TEMPORARY = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException"]);
// SES refused these for good; sending the same message again won't help.
const PERMANENT = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "BadRequestException",
  "NotFoundException",
]);

/**
 * Anything not known to be a refusal (server errors, timeouts, network drops)
 * is "unknown": the email may have gone out, so a person decides (CLAUDE.md).
 * Only the error name is kept, because messages can quote the address.
 */
export function classifySesError(error: unknown): SendResult {
  const name = error instanceof Error ? error.name : "non_error";
  if (TEMPORARY.has(name)) return { outcome: "rejected", code: name };
  if (PERMANENT.has(name)) return { outcome: "rejected", code: name, permanent: true };
  return { outcome: "unknown", code: name };
}

export function createSesProvider({ send, from }: { send: SesSend; from: string }): EmailProvider {
  return async (message: EmailMessage) => {
    let result: SendResult;
    try {
      const { MessageId } = await send({
        FromEmailAddress: from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: { Text: { Data: message.text, Charset: "UTF-8" } },
          },
        },
      });
      result = MessageId ? { outcome: "delivered", messageId: MessageId } : { outcome: "unknown", code: "no_message_id" };
    } catch (error) {
      result = classifySesError(error);
    }
    console.log(
      JSON.stringify({
        event: "ses_send",
        notification_id: message.notificationId,
        incident_id: message.incidentId,
        outcome: result.outcome,
        code: result.outcome === "delivered" ? undefined : result.code,
      }),
    );
    return result;
  };
}
