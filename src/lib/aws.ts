import { readFileSync } from "node:fs";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { Signer } from "@aws-sdk/rds-signer";
import type { PoolConfig } from "pg";
import type { SesSend } from "../notify/ses.ts";
import { dbSettings, toPoolConfig, type TokenSigner } from "./db-connection.ts";

// Thin adapters around the AWS SDK. Credentials come from the default chain,
// which on ECS is the task role: no keys are configured anywhere.

const signToken: TokenSigner = (request) => new Signer(request).getAuthToken();

/** Pool settings from the environment: DATABASE_URL locally, IAM auth on AWS. */
export function poolConfigFromEnv(env: Record<string, string | undefined>): PoolConfig {
  const settings = dbSettings(env);
  const ca = settings.kind !== "url" && env.DB_CA_FILE ? readFileSync(env.DB_CA_FILE, "utf8") : undefined;
  return toPoolConfig(settings, { sign: signToken, ca });
}

/**
 * SDK retries are off (maxAttempts 1): a retried send after a timeout could
 * email someone twice. The outbox policy decides what is safe to retry.
 */
export function createSesSend(region: string): SesSend {
  const client = new SESv2Client({ region, maxAttempts: 1, requestHandler: { requestTimeout: 10_000 } });
  return (input) => client.send(new SendEmailCommand(input));
}
