import { isTrustedSnsUrl } from "./sns.ts";

// Outbound calls to Amazon SNS, behind small function interfaces so tests and
// local development can use stubs (CLAUDE.md: external calls behind an interface).
// Every request: trusted SNS URL only (SSRF guard), 15 s timeout, no redirects.

const TIMEOUT_MS = 15_000;
const MAX_CERT_BYTES = 16 * 1024;
const MAX_CACHED_CERTS = 20;

export type CertFetcher = (url: string) => Promise<string>;
export type SubscriptionConfirmer = (subscribeUrl: string) => Promise<void>;

function assertTrusted(url: string): void {
  // The URL is attacker-supplied, so it is not echoed in the error.
  if (!isTrustedSnsUrl(url)) throw new Error("refusing untrusted SNS URL");
}

async function get(fetchFn: typeof fetch, url: string): Promise<Response> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new Error(`SNS request failed: HTTP ${response.status}`);
  return response;
}

export function createCertFetcher(fetchFn: typeof fetch = fetch): CertFetcher {
  const cache = new Map<string, string>();
  return async (url) => {
    assertTrusted(url);
    const cached = cache.get(url);
    if (cached) return cached;

    const pem = await (await get(fetchFn, url)).text();
    if (pem.length > MAX_CERT_BYTES) throw new Error("SNS certificate response too large");
    if (!pem.trimStart().startsWith("-----BEGIN CERTIFICATE-----")) throw new Error("SNS response is not a PEM certificate");

    if (cache.size >= MAX_CACHED_CERTS) cache.delete(cache.keys().next().value as string);
    cache.set(url, pem);
    return pem;
  };
}

export function createSubscriptionConfirmer(fetchFn: typeof fetch = fetch): SubscriptionConfirmer {
  return async (subscribeUrl) => {
    assertTrusted(subscribeUrl);
    await get(fetchFn, subscribeUrl);
  };
}

/** Development stub: never touches the network. */
export function createStubSubscriptionConfirmer(): SubscriptionConfirmer {
  return async () => {};
}
