import { describe, expect, it, vi } from "vitest";
import { dbSettings, toPoolConfig } from "./db-connection";

const iamEnv = {
  DB_AUTH: "iam",
  DB_HOST: "tracker.abc123.eu-west-2.rds.amazonaws.com",
  DB_PORT: "5432",
  DB_NAME: "incident_tracker",
  DB_USER: "tracker_app",
  AWS_REGION: "eu-west-2",
};

describe("dbSettings", () => {
  it("uses DATABASE_URL when IAM auth is off", () => {
    expect(dbSettings({ DATABASE_URL: "postgres://u:p@h:5432/db" })).toEqual({ kind: "url", connectionString: "postgres://u:p@h:5432/db" });
  });

  it("fails clearly when nothing is configured", () => {
    expect(() => dbSettings({})).toThrow(/DATABASE_URL/);
  });

  it("reads host, port, database, user and region for IAM auth", () => {
    expect(dbSettings(iamEnv)).toEqual({
      kind: "iam",
      host: iamEnv.DB_HOST,
      port: 5432,
      database: "incident_tracker",
      user: "tracker_app",
      region: "eu-west-2",
    });
  });

  it("ignores DATABASE_URL when IAM auth is on, so no password can sneak in", () => {
    expect(dbSettings({ ...iamEnv, DATABASE_URL: "postgres://u:p@h:5432/db" }).kind).toBe("iam");
  });

  it("defaults the port to 5432", () => {
    const env: Record<string, string> = { ...iamEnv };
    delete env.DB_PORT;
    expect(dbSettings(env)).toMatchObject({ port: 5432 });
  });

  it.each(["DB_HOST", "DB_NAME", "DB_USER", "AWS_REGION"])("refuses IAM auth without %s", (name) => {
    expect(() => dbSettings({ ...iamEnv, [name]: "" })).toThrow(name);
  });

  it("refuses a port that is not a number", () => {
    expect(() => dbSettings({ ...iamEnv, DB_PORT: "abc" })).toThrow(/DB_PORT/);
  });

  it("refuses an unknown DB_AUTH instead of falling back to a password", () => {
    expect(() => dbSettings({ ...iamEnv, DB_AUTH: "IAM" })).toThrow(/DB_AUTH/);
  });

  it("reads the managed secret mode used only by the migration task", () => {
    const env: Record<string, string> = { ...iamEnv };
    delete env.AWS_REGION;
    expect(dbSettings({ ...env, DB_AUTH: "secret", DB_PASSWORD: "from-secrets-manager" })).toEqual({
      kind: "secret",
      host: iamEnv.DB_HOST,
      port: 5432,
      database: "incident_tracker",
      user: "tracker_app",
      password: "from-secrets-manager",
    });
  });

  it("refuses secret mode without DB_PASSWORD", () => {
    expect(() => dbSettings({ ...iamEnv, DB_AUTH: "secret" })).toThrow(/DB_PASSWORD/);
  });
});

describe("toPoolConfig", () => {
  it("passes a connection string through", () => {
    const config = toPoolConfig({ kind: "url", connectionString: "postgres://u:p@h:5432/db" }, { sign: vi.fn() });
    expect(config).toEqual({ connectionString: "postgres://u:p@h:5432/db" });
  });

  it("signs a fresh token for every new connection instead of storing a password", async () => {
    const sign = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
    const config = toPoolConfig(dbSettings(iamEnv), { sign, ca: "CA" });
    expect(config).toMatchObject({ host: iamEnv.DB_HOST, port: 5432, database: "incident_tracker", user: "tracker_app" });
    expect(typeof config.password).toBe("function");

    const password = config.password as () => Promise<string>;
    expect(await password()).toBe("token-1");
    expect(await password()).toBe("token-2");
    expect(sign).toHaveBeenCalledWith({ hostname: iamEnv.DB_HOST, port: 5432, username: "tracker_app", region: "eu-west-2" });
  });

  it("requires TLS with certificate checks for IAM auth", () => {
    const config = toPoolConfig(dbSettings(iamEnv), { sign: vi.fn(), ca: "CA" });
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: "CA" });
  });

  it("refuses IAM auth without a CA bundle to check the server against", () => {
    expect(() => toPoolConfig(dbSettings(iamEnv), { sign: vi.fn() })).toThrow(/CA/);
  });

  it("uses the managed secret over verified TLS, and never signs a token", () => {
    const sign = vi.fn();
    const settings = dbSettings({ ...iamEnv, DB_AUTH: "secret", DB_PASSWORD: "from-secrets-manager" });
    expect(toPoolConfig(settings, { sign, ca: "CA" })).toEqual({
      host: iamEnv.DB_HOST,
      port: 5432,
      database: "incident_tracker",
      user: "tracker_app",
      password: "from-secrets-manager",
      ssl: { rejectUnauthorized: true, ca: "CA" },
    });
    expect(sign).not.toHaveBeenCalled();
    expect(() => toPoolConfig(settings, { sign })).toThrow(/CA/);
  });
});
