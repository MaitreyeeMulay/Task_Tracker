import { createHash } from "node:crypto";
import { z } from "zod";

export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export interface NormalizedAlert {
  source: "cloudwatch";
  externalId: string;
  fingerprint: string;
  status: "firing" | "resolved";
  severity: Severity;
  title: string;
  summary: string;
  occurredAt: Date;
}

export type ParseResult = { ok: true; alert: NormalizedAlert } | { ok: false; error: string };

// Only the fields we use are validated; anything else in the payload is ignored.
const SnsNotification = z.object({
  Type: z.literal("Notification"),
  MessageId: z.string().min(1).max(100),
  Message: z.string().min(2).max(256 * 1024),
});

const CloudWatchAlarm = z.object({
  AlarmName: z.string().min(1).max(255),
  AlarmDescription: z.string().max(1024).nullish(),
  AlarmArn: z
    .string()
    .max(512)
    .regex(/^arn:aws[\w-]*:cloudwatch:[\w-]+:\d{12}:alarm:.+$/),
  NewStateValue: z.enum(["ALARM", "OK", "INSUFFICIENT_DATA"]),
  NewStateReason: z.string().max(1023),
  StateChangeTime: z.string().max(40),
});

// Errors name the failing fields, never their values (payloads are untrusted).
function fieldsOf(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join(".") || "(root)"))].join(", ");
}

// CloudWatch writes offsets as +0000; Date needs +00:00.
function parseTimestamp(value: string): Date | null {
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(date.getTime()) ? null : date;
}

// "[SEV1]", "sev2:" etc. in the alarm description; SEV3 when absent.
function severityFrom(description: string | null | undefined): Severity {
  const match = /\bsev([1-4])\b/i.exec(description ?? "");
  return match ? (`SEV${match[1]}` as Severity) : "SEV3";
}

// Same alarm => same fingerprint, regardless of state, reason or time.
function fingerprintOf(alarmArn: string): string {
  return createHash("sha256").update(`cloudwatch\n${alarmArn}`).digest("hex");
}

export function parseCloudWatchAlarm(input: unknown): ParseResult {
  const envelope = SnsNotification.safeParse(input);
  if (!envelope.success) return { ok: false, error: `invalid SNS notification: ${fieldsOf(envelope.error)}` };

  let message: unknown;
  try {
    message = JSON.parse(envelope.data.Message);
  } catch {
    return { ok: false, error: "SNS Message is not valid JSON" };
  }

  const alarm = CloudWatchAlarm.safeParse(message);
  if (!alarm.success) return { ok: false, error: `invalid CloudWatch alarm: ${fieldsOf(alarm.error)}` };

  const { AlarmName, AlarmDescription, AlarmArn, NewStateValue, NewStateReason, StateChangeTime } = alarm.data;
  if (NewStateValue === "INSUFFICIENT_DATA") return { ok: false, error: "ignored state INSUFFICIENT_DATA" };

  const occurredAt = parseTimestamp(StateChangeTime);
  if (!occurredAt) return { ok: false, error: "invalid CloudWatch alarm: StateChangeTime" };

  return {
    ok: true,
    alert: {
      source: "cloudwatch",
      externalId: envelope.data.MessageId,
      fingerprint: fingerprintOf(AlarmArn),
      status: NewStateValue === "ALARM" ? "firing" : "resolved",
      severity: severityFrom(AlarmDescription),
      title: AlarmName,
      summary: NewStateReason,
      occurredAt,
    },
  };
}
