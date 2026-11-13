import type { PoolConfig } from "pg";

// How code reaches Postgres, chosen by DB_AUTH:
// - unset: DATABASE_URL (local development and CI).
// - "iam": IAM database authentication for the app and worker on AWS. No
//   password exists; each new connection signs a 15-minute token with the
//   task's own AWS identity (CLAUDE.md: identities between cloud services).
// - "secret": the migration task only. It connects as the database owner with
//   the RDS-managed, auto-rotated master secret, which ECS injects as
//   DB_PASSWORD through the task's identity. See docs/security-decisions.md.

interface Endpoint {
  host: string;
  port: number;
  database: string;
  user: string;
}

export type DbSettings =
  | { kind: "url"; connectionString: string }
  | ({ kind: "iam"; region: string } & Endpoint)
  | ({ kind: "secret"; password: string } & Endpoint);

export type TokenSigner = (request: { hostname: string; port: number; username: string; region: string }) => Promise<string>;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when DB_AUTH=${env.DB_AUTH}.`);
  return value;
}

function endpoint(env: Record<string, string | undefined>): Endpoint {
  const port = Number(env.DB_PORT ?? "5432");
  if (!Number.isInteger(port) || port <= 0) throw new Error("DB_PORT must be a port number.");
  return { host: required(env, "DB_HOST"), port, database: required(env, "DB_NAME"), user: required(env, "DB_USER") };
}

export function dbSettings(env: Record<string, string | undefined>): DbSettings {
  switch (env.DB_AUTH) {
    case undefined:
    case "":
      if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set. See .env.example.");
      return { kind: "url", connectionString: env.DATABASE_URL };
    case "iam":
      return { kind: "iam", ...endpoint(env), region: required(env, "AWS_REGION") };
    case "secret":
      return { kind: "secret", ...endpoint(env), password: required(env, "DB_PASSWORD") };
    default:
      throw new Error("DB_AUTH must be iam or secret, or unset to use DATABASE_URL.");
  }
}

/** `ca` is the RDS certificate bundle; credentials are only ever sent over verified TLS. */
export function toPoolConfig(settings: DbSettings, { sign, ca }: { sign: TokenSigner; ca?: string | undefined }): PoolConfig {
  if (settings.kind === "url") return { connectionString: settings.connectionString };
  if (!ca) throw new Error("Connecting to RDS needs its CA bundle (DB_CA_FILE).");
  const { host, port, database, user } = settings;
  const password = settings.kind === "secret" ? settings.password : () => sign({ hostname: host, port, username: user, region: settings.region });
  return { host, port, database, user, password, ssl: { rejectUnauthorized: true, ca } };
}
