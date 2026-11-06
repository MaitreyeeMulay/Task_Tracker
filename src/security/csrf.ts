// Cross-site request forgery check for every state-changing browser request
// (on top of SameSite=Lax cookies and Next.js's own server-action Origin check).
// A request is forged when the browser says it came from another site, or its
// Origin is not exactly this host. Signed machine endpoints are exempt.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MACHINE_PATHS = ["/api/ingest/"];

export function isForgedRequest(req: { method: string; host: string; path: string; origin: string | null; secFetchSite: string | null }): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  if (MACHINE_PATHS.some((prefix) => req.path.startsWith(prefix))) return false;

  if (req.secFetchSite === "cross-site") return true;
  if (req.origin === null) return req.secFetchSite !== "same-origin" && req.secFetchSite !== null && req.secFetchSite !== "none";
  try {
    return new URL(req.origin).host !== req.host;
  } catch {
    return true; // "null" or garbage
  }
}
