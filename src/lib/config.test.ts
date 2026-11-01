import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("enables dev login in development when the flag is set", () => {
    const config = loadConfig({ NODE_ENV: "development", DEV_LOGIN_ENABLED: "true" });
    expect(config.devLoginEnabled).toBe(true);
  });

  it("never enables dev login in production, even when the flag is set", () => {
    const config = loadConfig({ NODE_ENV: "production", DEV_LOGIN_ENABLED: "true" });
    expect(config.devLoginEnabled).toBe(false);
  });

  it("defaults dev login to off", () => {
    expect(loadConfig({ NODE_ENV: "development" }).devLoginEnabled).toBe(false);
  });

  it("only accepts the exact string 'true'", () => {
    expect(loadConfig({ NODE_ENV: "development", DEV_LOGIN_ENABLED: "1" }).devLoginEnabled).toBe(false);
  });

  it("reads the session secret, current first, then the previous one during rotation", () => {
    expect(loadConfig({ SESSION_SECRET: "a", SESSION_SECRET_PREVIOUS: "b" }).sessionSecrets).toEqual(["a", "b"]);
    expect(loadConfig({ SESSION_SECRET: "a" }).sessionSecrets).toEqual(["a"]);
    expect(loadConfig({}).sessionSecrets).toEqual([]);
  });

  it("treats an unknown NODE_ENV as production", () => {
    const config = loadConfig({ NODE_ENV: "staging", DEV_LOGIN_ENABLED: "true" });
    expect(config.environment).toBe("production");
    expect(config.devLoginEnabled).toBe(false);
  });
});
