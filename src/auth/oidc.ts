import * as client from "openid-client";
import type { Pool } from "pg";
import type { Flow } from "./flow-cookie.ts";

// OIDC sign-in for production (authorization code flow with PKCE, state and
// nonce), using openid-client: an OpenID-certified library, because hand-rolled
// OIDC is a classic source of security bugs. Token validation (signature via
// JWKS, iss, aud, exp, nonce) is the library's job and is exercised end to end
// in test/db/oidc.test.ts against a fake provider.
//
// No self-signup (SPEC non-goal): only users who already exist can sign in.
// First login links the provider subject by a *verified* email; after that the
// subject alone identifies the user.

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Tests only: the fake provider runs on plain http. Never set in the app. */
  allowInsecureForTests?: boolean;
}

const configs = new Map<string, Promise<client.Configuration>>();

function configFor(settings: OidcSettings): Promise<client.Configuration> {
  const key = `${settings.issuer}|${settings.clientId}`;
  let config = configs.get(key);
  if (!config) {
    config = client.discovery(
      new URL(settings.issuer),
      settings.clientId,
      settings.clientSecret,
      undefined,
      settings.allowInsecureForTests ? { execute: [client.allowInsecureRequests], timeout: 15 } : { timeout: 15 },
    );
    // Don't cache a failed discovery.
    config.catch(() => configs.delete(key));
    configs.set(key, config);
  }
  return config;
}

export async function startOidcLogin(settings: OidcSettings): Promise<{ authorizationUrl: string; flow: Flow }> {
  const config = await configFor(settings);
  const flow: Flow = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier() };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
    code_challenge_method: "S256",
    state: flow.state,
    nonce: flow.nonce,
  });
  return { authorizationUrl: url.href, flow };
}

export async function finishOidcLogin(
  pool: Pool,
  settings: OidcSettings,
  { callbackUrl, flow }: { callbackUrl: URL; flow: Flow },
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  let claims: client.IDToken | undefined;
  try {
    const config = await configFor(settings);
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch (error) {
    // State mismatch, bad code, bad signature, wrong audience, expired token...
    console.warn(JSON.stringify({ event: "oidc_rejected", code: (error as { code?: string }).code ?? "unknown" }));
    return { ok: false, error: "invalid_response" };
  }
  if (!claims?.sub) return { ok: false, error: "invalid_response" };

  const subject = `${claims.iss}|${claims.sub}`.slice(0, 600);
  const email = typeof claims.email === "string" ? claims.email : null;
  const verified = claims.email_verified === true;

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE app_auth");
    let userId = (await db.query<{ id: string }>("SELECT id FROM users WHERE oidc_subject = $1", [subject])).rows[0]?.id;
    if (!userId && email && verified) {
      userId = (
        await db.query<{ id: string }>(
          "UPDATE users SET oidc_subject = $1 WHERE lower(email) = lower($2) AND oidc_subject IS NULL RETURNING id",
          [subject, email.slice(0, 320)],
        )
      ).rows[0]?.id;
    }
    if (!userId) {
      await db.query("COMMIT");
      console.warn(JSON.stringify({ event: "oidc_not_invited" }));
      return { ok: false, error: "not_invited" };
    }
    await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    await db.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id) VALUES ($1, 'auth.login_succeeded', 'user', $2)`, [userId, userId]);
    await db.query("COMMIT");
    return { ok: true, userId };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
