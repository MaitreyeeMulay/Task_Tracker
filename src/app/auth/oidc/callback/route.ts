import { cookies } from "next/headers";
import { FLOW_COOKIE, openFlow } from "@/auth/flow-cookie";
import { finishOidcLogin } from "@/auth/oidc";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/auth/session";
import { loadConfig } from "@/lib/config";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /auth/oidc/callback?code=…&state=… → validate with the provider, then
// start a session for an existing user. Any failure goes back to /login.
export async function GET(request: Request) {
  const config = loadConfig(process.env);
  const secret = config.sessionSecrets[0];
  if (!config.oidc || !secret) return new Response("Not found", { status: 404 });

  const jar = await cookies();
  const flow = openFlow(jar.get(FLOW_COOKIE)?.value, { secrets: config.sessionSecrets, now: new Date() });
  jar.delete({ name: FLOW_COOKIE, path: "/auth/oidc" });
  const toLogin = (reason: string) => Response.redirect(new URL(`/login?error=${reason}`, config.oidc?.redirectUri), 302);
  if (!flow) return toLogin("sso_expired");

  // Rebuild the callback URL on the configured redirect URI, so a proxy's
  // internal host name can never change what the provider's response is checked against.
  const callbackUrl = new URL(config.oidc.redirectUri);
  callbackUrl.search = new URL(request.url).search;

  const result = await finishOidcLogin(getPool(), config.oidc, { callbackUrl, flow });
  if (!result.ok) return toLogin(result.error === "not_invited" ? "sso_not_invited" : "sso_failed");

  jar.set(SESSION_COOKIE, createSessionToken(result.userId, { secret, now: new Date() }), sessionCookieOptions(config.environment));
  console.log(JSON.stringify({ event: "login", method: "oidc", user_id: result.userId }));
  return Response.redirect(new URL("/incidents", config.oidc.redirectUri), 302);
}
