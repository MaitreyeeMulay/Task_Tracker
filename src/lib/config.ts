export type Environment = "development" | "test" | "production";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Config {
  environment: Environment;
  devLoginEnabled: boolean;
  /** Current secret first; the previous one only while rotating. */
  sessionSecrets: string[];
  /** Set only when fully configured (and https outside development). */
  oidc: OidcConfig | null;
}

// Unknown values fall back to production so the safest settings apply.
function parseEnvironment(value: string | undefined): Environment {
  return value === "development" || value === "test" ? value : "production";
}

function parseOidc(env: Record<string, string | undefined>, environment: Environment): OidcConfig | null {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, OIDC_REDIRECT_URI: redirectUri } = env;
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  if (environment !== "development" && !(issuer.startsWith("https://") && redirectUri.startsWith("https://"))) return null;
  return { issuer, clientId, clientSecret, redirectUri };
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const environment = parseEnvironment(env.NODE_ENV);
  return {
    environment,
    devLoginEnabled: environment !== "production" && env.DEV_LOGIN_ENABLED === "true",
    sessionSecrets: [env.SESSION_SECRET, env.SESSION_SECRET_PREVIOUS].filter((s): s is string => Boolean(s)),
    oidc: parseOidc(env, environment),
  };
}
