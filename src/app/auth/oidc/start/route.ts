import { cookies } from "next/headers";
import { FLOW_COOKIE, sealFlow } from "@/auth/flow-cookie";
import { startOidcLogin } from "@/auth/oidc";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

// GET /auth/oidc/start → redirect to the identity provider, remembering the
// state, nonce and PKCE verifier in a short-lived signed cookie.
export async function GET() {
  const config = loadConfig(process.env);
  const secret = config.sessionSecrets[0];
  if (!config.oidc || !secret) return new Response("Not found", { status: 404 });

  const { authorizationUrl, flow } = await startOidcLogin(config.oidc);
  (await cookies()).set(FLOW_COOKIE, sealFlow(flow, { secret, now: new Date() }), {
    httpOnly: true,
    // Lax: the cookie must come back on the provider's top-level redirect to /auth/oidc/callback.
    sameSite: "lax",
    secure: config.environment === "production",
    path: "/auth/oidc",
    maxAge: 600,
  });
  return Response.redirect(authorizationUrl, 302);
}
