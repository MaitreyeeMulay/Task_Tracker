export type Environment = "development" | "test" | "production";

export interface Config {
  environment: Environment;
  devLoginEnabled: boolean;
}

// Unknown values fall back to production so the safest settings apply.
function parseEnvironment(value: string | undefined): Environment {
  return value === "development" || value === "test" ? value : "production";
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const environment = parseEnvironment(env.NODE_ENV);
  return {
    environment,
    devLoginEnabled: environment !== "production" && env.DEV_LOGIN_ENABLED === "true",
  };
}
