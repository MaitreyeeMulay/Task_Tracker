import { createRateLimiter } from "./rate-limit.ts";

// Process-wide limiters (one per app instance; see rate-limit.ts).
export const loginByIp = createRateLimiter({ limit: 20, windowMs: 60_000 });
export const loginByEmail = createRateLimiter({ limit: 10, windowMs: 60_000 });
export const ingestByIntegration = createRateLimiter({ limit: 300, windowMs: 60_000 });

/**
 * Client address for rate limiting. X-Forwarded-For is trusted only when the
 * app is behind a known proxy (TRUST_PROXY=true), because clients can forge it.
 */
export function clientAddress(headers: Headers): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return "direct";
}
