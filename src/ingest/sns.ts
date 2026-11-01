import { createVerify } from "node:crypto";
import { z } from "zod";

// Verifies Amazon SNS HTTP(S) messages, following AWS's documented procedure:
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
// On top of that, the topic must be the one configured for the integration:
// a valid AWS signature only proves AWS sent it, not that it is OUR topic.

const SnsMessageSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().min(1).max(100),
  TopicArn: z.string().min(1).max(256),
  Message: z.string().max(256 * 1024),
  Timestamp: z.string().min(1).max(40),
  SignatureVersion: z.string().max(4),
  Signature: z.string().min(1).max(2048),
  SigningCertURL: z.string().max(2048),
  Subject: z.string().max(100).optional(),
  SubscribeURL: z.string().max(2048).optional(),
  Token: z.string().max(2048).optional(),
});

export type SnsMessage = z.infer<typeof SnsMessageSchema>;

export type SnsVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "malformed" | "unexpected_topic" | "unsupported_signature_version" | "untrusted_cert_url" | "cert_unavailable" | "bad_signature";
    };

export interface SnsVerifyOptions {
  expectedTopicArn: string;
  /** Fetches a PEM certificate. Only ever called with a URL that passed isTrustedSnsUrl. */
  fetchCert: (url: string) => Promise<string>;
}

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

export function snsStringToSign(message: SnsMessage): string {
  const keys = message.Type === "Notification" ? NOTIFICATION_KEYS : SUBSCRIPTION_KEYS;
  let text = "";
  for (const key of keys) {
    const value = message[key];
    if (value !== undefined) text += `${key}\n${value}\n`;
  }
  return text;
}

// https only, default port, no user info, host exactly sns.<region>.amazonaws.com(.cn).
const SNS_HOST = /^sns\.[a-z]{2}(-[a-z]+)+-\d\.amazonaws\.com(\.cn)?$/;

export function isTrustedSnsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && SNS_HOST.test(url.hostname);
}

export async function verifySnsMessage(input: unknown, { expectedTopicArn, fetchCert }: SnsVerifyOptions): Promise<SnsVerifyResult> {
  const parsed = SnsMessageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const message = parsed.data;

  // Cheap checks first, so nothing is fetched for messages we would reject anyway.
  if (message.TopicArn !== expectedTopicArn) return { ok: false, reason: "unexpected_topic" };
  if (message.SignatureVersion !== "2") return { ok: false, reason: "unsupported_signature_version" };
  if (!isTrustedSnsUrl(message.SigningCertURL)) return { ok: false, reason: "untrusted_cert_url" };

  let certificate: string;
  try {
    certificate = await fetchCert(message.SigningCertURL);
  } catch {
    return { ok: false, reason: "cert_unavailable" };
  }

  let valid = false;
  try {
    valid = createVerify("RSA-SHA256").update(snsStringToSign(message)).verify(certificate, message.Signature, "base64");
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
