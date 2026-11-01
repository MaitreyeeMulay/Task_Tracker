import { describe, expect, it } from "vitest";
import { createCertFetcher, createSubscriptionConfirmer } from "./sns-http.ts";

const CERT_URL = "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc.pem";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

function fakeFetch(body: string, status = 200) {
  const calls: { url: string; signal: AbortSignal | undefined; redirect: string | undefined }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), signal: init?.signal ?? undefined, redirect: init?.redirect });
    return new Response(body, { status });
  };
  return { fn: fn as typeof fetch, calls };
}

describe("createCertFetcher", () => {
  it("fetches a certificate with a timeout and no redirects", async () => {
    const { fn, calls } = fakeFetch(PEM);
    expect(await createCertFetcher(fn)(CERT_URL)).toBe(PEM);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.redirect).toBe("error");
  });

  it("caches by URL", async () => {
    const { fn, calls } = fakeFetch(PEM);
    const fetchCert = createCertFetcher(fn);
    await fetchCert(CERT_URL);
    await fetchCert(CERT_URL);
    expect(calls).toHaveLength(1);
  });

  it("refuses untrusted URLs without making a request", async () => {
    const { fn, calls } = fakeFetch(PEM);
    await expect(createCertFetcher(fn)("https://evil.example/x.pem")).rejects.toThrow(/untrusted/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a response that is not a PEM certificate", async () => {
    await expect(createCertFetcher(fakeFetch("<html>").fn)(CERT_URL)).rejects.toThrow(/not a PEM certificate/);
  });

  it("rejects an oversized response", async () => {
    await expect(createCertFetcher(fakeFetch(PEM + "x".repeat(20_000)).fn)(CERT_URL)).rejects.toThrow(/too large/);
  });

  it("rejects HTTP errors", async () => {
    await expect(createCertFetcher(fakeFetch("nope", 404).fn)(CERT_URL)).rejects.toThrow(/HTTP 404/);
  });

  it("does not cache failures", async () => {
    const { fn, calls } = fakeFetch("nope", 500);
    const fetchCert = createCertFetcher(fn);
    await expect(fetchCert(CERT_URL)).rejects.toThrow();
    await expect(fetchCert(CERT_URL)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});

describe("createSubscriptionConfirmer", () => {
  const SUBSCRIBE_URL = "https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription&Token=t";

  it("calls the SubscribeURL once, with a timeout and no redirects", async () => {
    const { fn, calls } = fakeFetch("<ConfirmSubscriptionResponse/>");
    await createSubscriptionConfirmer(fn)(SUBSCRIBE_URL);
    expect(calls).toEqual([{ url: SUBSCRIBE_URL, signal: expect.any(AbortSignal), redirect: "error" }]);
  });

  it("refuses an untrusted SubscribeURL (SSRF) without making a request", async () => {
    const { fn, calls } = fakeFetch("");
    await expect(createSubscriptionConfirmer(fn)("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/untrusted/);
    expect(calls).toHaveLength(0);
  });

  it("fails on HTTP errors", async () => {
    await expect(createSubscriptionConfirmer(fakeFetch("", 403).fn)(SUBSCRIBE_URL)).rejects.toThrow(/HTTP 403/);
  });
});
