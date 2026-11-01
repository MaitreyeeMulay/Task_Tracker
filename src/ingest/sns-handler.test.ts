import { describe, expect, it } from "vitest";
import fixture from "./fixtures/sns-cloudwatch-alarm.json" with { type: "json" };
import { handleSnsIngest, readBodyLimited, type SnsHandlerDeps } from "./sns-handler.ts";
import type { SnsIntegration } from "./store.ts";

const INTEGRATION: SnsIntegration = {
  id: "11111111-1111-4111-8111-111111111111",
  serviceId: "s",
  teamId: "t",
  topicArn: fixture.TopicArn,
};

function deps(overrides: Partial<SnsHandlerDeps> = {}) {
  const logs: Record<string, unknown>[] = [];
  const calls = { confirm: [] as string[], ingest: 0 };
  const d: SnsHandlerDeps = {
    findIntegration: async (id) => (id === INTEGRATION.id ? INTEGRATION : null),
    verify: async () => ({ ok: true }),
    confirmSubscription: async (url) => {
      calls.confirm.push(url);
    },
    ingest: async () => {
      calls.ingest++;
      return { kind: "incident_opened", incidentId: "inc-1" };
    },
    log: (event) => logs.push(event),
    ...overrides,
  };
  return { d, logs, calls };
}

const body = JSON.stringify(fixture);

describe("handleSnsIngest", () => {
  it("opens an incident for a verified CloudWatch alarm (201)", async () => {
    const { d, logs } = deps();
    expect(await handleSnsIngest({ integrationId: INTEGRATION.id, body }, d)).toEqual({
      status: 201,
      body: { result: "incident_opened", incidentId: "inc-1" },
    });
    expect(logs).toEqual([{ event: "sns_ingest", integration_id: INTEGRATION.id, outcome: "incident_opened", incident_id: "inc-1" }]);
  });

  it("returns 200 for a duplicate that joined an existing incident", async () => {
    const { d } = deps({ ingest: async () => ({ kind: "incident_updated", incidentId: "inc-1", alertCount: 2 }) });
    expect(await handleSnsIngest({ integrationId: INTEGRATION.id, body }, d)).toEqual({
      status: 200,
      body: { result: "incident_updated", incidentId: "inc-1" },
    });
  });

  it("rejects an oversized body (413) before doing anything", async () => {
    const { d, calls } = deps();
    expect((await handleSnsIngest({ integrationId: INTEGRATION.id, body: null }, d)).status).toBe(413);
    expect(calls.ingest).toBe(0);
  });

  it("rejects invalid JSON (400)", async () => {
    expect((await handleSnsIngest({ integrationId: INTEGRATION.id, body: "{nope" }, deps().d)).status).toBe(400);
  });

  it("returns 404 for an unknown integration, without verifying", async () => {
    let verified = false;
    const { d } = deps({ verify: async () => ((verified = true), { ok: true }) });
    expect((await handleSnsIngest({ integrationId: "22222222-2222-4222-8222-222222222222", body }, d)).status).toBe(404);
    expect(verified).toBe(false);
  });

  it("rejects a forged or foreign message (403) and logs only the reason", async () => {
    const { d, logs, calls } = deps({ verify: async () => ({ ok: false, reason: "bad_signature" }) });
    expect(await handleSnsIngest({ integrationId: INTEGRATION.id, body }, d)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(calls.ingest).toBe(0);
    expect(logs).toEqual([{ event: "sns_ingest_rejected", integration_id: INTEGRATION.id, reason: "bad_signature" }]);
  });

  it("passes the integration's topic to verification", async () => {
    let topic = "";
    const { d } = deps({ verify: async (_m, t) => ((topic = t), { ok: true }) });
    await handleSnsIngest({ integrationId: INTEGRATION.id, body }, d);
    expect(topic).toBe(fixture.TopicArn);
  });

  it("confirms a verified subscription once (200)", async () => {
    const { d, calls } = deps();
    const confirmation = JSON.stringify({ ...fixture, Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription", Token: "t" });
    expect(await handleSnsIngest({ integrationId: INTEGRATION.id, body: confirmation }, d)).toEqual({ status: 200, body: { result: "subscribed" } });
    expect(calls.confirm).toEqual(["https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription"]);
    expect(calls.ingest).toBe(0);
  });

  it("returns 502 if confirming the subscription fails", async () => {
    const { d } = deps({ confirmSubscription: async () => Promise.reject(new Error("timeout")) });
    const confirmation = JSON.stringify({ ...fixture, Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.eu-west-2.amazonaws.com/?x", Token: "t" });
    expect((await handleSnsIngest({ integrationId: INTEGRATION.id, body: confirmation }, d)).status).toBe(502);
  });

  it("accepts but ignores INSUFFICIENT_DATA (202)", async () => {
    const message = { ...JSON.parse(fixture.Message), NewStateValue: "INSUFFICIENT_DATA" };
    const { d, calls } = deps();
    const result = await handleSnsIngest({ integrationId: INTEGRATION.id, body: JSON.stringify({ ...fixture, Message: JSON.stringify(message) }) }, d);
    expect(result).toEqual({ status: 202, body: { result: "ignored" } });
    expect(calls.ingest).toBe(0);
  });

  it("returns 422 for a verified message that is not a CloudWatch alarm", async () => {
    const result = await handleSnsIngest({ integrationId: INTEGRATION.id, body: JSON.stringify({ ...fixture, Message: '{"hello":"world"}' }) }, deps().d);
    expect(result.status).toBe(422);
  });

  it("returns a generic 500 if the database fails, without leaking the error", async () => {
    const { d, logs } = deps({ ingest: async () => Promise.reject(new Error("connection to 10.0.0.5 refused")) });
    const result = await handleSnsIngest({ integrationId: INTEGRATION.id, body }, d);
    expect(result).toEqual({ status: 500, body: { error: "internal error" } });
    expect(JSON.stringify(logs)).not.toContain("10.0.0.5");
  });
});

describe("readBodyLimited", () => {
  const post = (text: string, headers: Record<string, string> = {}) => new Request("http://x/", { method: "POST", body: text, headers });

  it("returns the body when within the limit", async () => {
    expect(await readBodyLimited(post("hello"), 10)).toBe("hello");
  });

  it("returns null when the body exceeds the limit", async () => {
    expect(await readBodyLimited(post("x".repeat(11)), 10)).toBeNull();
  });

  it("returns null early when Content-Length declares too much", async () => {
    expect(await readBodyLimited(post("tiny", { "content-length": "999999" }), 10)).toBeNull();
  });

  it("returns an empty string for no body", async () => {
    expect(await readBodyLimited(new Request("http://x/", { method: "POST" }), 10)).toBe("");
  });
});
