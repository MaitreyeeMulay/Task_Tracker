import { NextResponse, type NextRequest } from "next/server";
import { isForgedRequest } from "./security/csrf";
import { securityHeaders } from "./security/headers";

// Runs before every page and route (Next.js 16 "proxy", formerly middleware):
//  1. blocks forged cross-site state-changing requests (CSRF), and
//  2. sets the security headers, with a fresh CSP nonce that Next.js applies to its scripts.

export function proxy(request: NextRequest) {
  const forged = isForgedRequest({
    method: request.method,
    host: request.headers.get("host") ?? request.nextUrl.host,
    path: request.nextUrl.pathname,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (forged) {
    console.warn(JSON.stringify({ event: "csrf_blocked", path: request.nextUrl.pathname.slice(0, 100) }));
    return new NextResponse("Forbidden", { status: 403 });
  }

  const nonce = btoa(crypto.randomUUID());
  const headers = securityHeaders({ nonce, production: process.env.NODE_ENV === "production" });
  const csp = headers["Content-Security-Policy"] ?? "";

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
