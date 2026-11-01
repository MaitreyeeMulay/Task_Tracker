import { parseCloudWatchAlarm, type NormalizedAlert } from "./cloudwatch.ts";
import type { SnsVerifyResult } from "./sns.ts";
import type { IngestOutcome, SnsIntegration } from "./store.ts";

// HTTP-agnostic SNS ingestion: the route only reads the body and maps the result.
// Dependencies are injected so every path is unit-tested without network or DB.

export interface SnsHandlerDeps {
  findIntegration: (id: string) => Promise<SnsIntegration | null>;
  verify: (message: unknown, expectedTopicArn: string) => Promise<SnsVerifyResult>;
  confirmSubscription: (subscribeUrl: string) => Promise<void>;
  ingest: (integration: SnsIntegration, alert: NormalizedAlert, payload: unknown) => Promise<IngestOutcome>;
  /** Ids, outcomes and reasons only: never payloads or error messages. */
  log: (event: Record<string, string | number>) => void;
}

export interface HandlerResult {
  status: number;
  body: Record<string, string>;
}

/** Reads at most maxBytes; returns null if the body is larger (caller answers 413). */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const reply = (status: number, body: Record<string, string>): HandlerResult => ({ status, body });

export async function handleSnsIngest(
  { integrationId, body }: { integrationId: string; body: string | null },
  deps: SnsHandlerDeps,
): Promise<HandlerResult> {
  if (body === null) return reply(413, { error: "payload too large" });

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return reply(400, { error: "invalid JSON" });
  }

  try {
    const integration = await deps.findIntegration(integrationId);
    if (!integration) return reply(404, { error: "not found" });

    const verified = await deps.verify(message, integration.topicArn);
    if (!verified.ok) {
      deps.log({ event: "sns_ingest_rejected", integration_id: integration.id, reason: verified.reason });
      return reply(403, { error: "forbidden" });
    }

    const { Type, SubscribeURL } = message as { Type: string; SubscribeURL?: string };
    if (Type === "SubscriptionConfirmation" && SubscribeURL) {
      try {
        await deps.confirmSubscription(SubscribeURL);
      } catch {
        deps.log({ event: "sns_subscription_confirm_failed", integration_id: integration.id });
        return reply(502, { error: "could not confirm subscription" });
      }
      deps.log({ event: "sns_subscription_confirmed", integration_id: integration.id });
      return reply(200, { result: "subscribed" });
    }
    if (Type !== "Notification") return reply(200, { result: "ignored" });

    const parsed = parseCloudWatchAlarm(message);
    if (!parsed.ok) {
      const ignored = parsed.error.startsWith("ignored");
      deps.log({ event: ignored ? "sns_ingest_ignored" : "sns_ingest_invalid", integration_id: integration.id });
      return ignored ? reply(202, { result: "ignored" }) : reply(422, { error: "not a CloudWatch alarm" });
    }

    const outcome = await deps.ingest(integration, parsed.alert, message);
    const incidentId = "incidentId" in outcome ? outcome.incidentId : undefined;
    deps.log({
      event: "sns_ingest",
      integration_id: integration.id,
      outcome: outcome.kind,
      ...(incidentId ? { incident_id: incidentId } : {}),
    });
    return reply(outcome.kind === "incident_opened" ? 201 : 200, { result: outcome.kind, ...(incidentId ? { incidentId } : {}) });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    deps.log({ event: "sns_ingest_error", integration_id: integrationId.slice(0, 36), code: typeof code === "string" ? code : "unknown" });
    return reply(500, { error: "internal error" });
  }
}
