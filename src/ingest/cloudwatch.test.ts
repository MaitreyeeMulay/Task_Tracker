import { describe, expect, it } from "vitest";
import fixture from "./fixtures/sns-cloudwatch-alarm.json" with { type: "json" };
import { parseCloudWatchAlarm } from "./cloudwatch.ts";

type Envelope = typeof fixture;

function withMessage(change: Record<string, unknown>): Envelope {
  const message = { ...JSON.parse(fixture.Message), ...change };
  return { ...fixture, Message: JSON.stringify(message) };
}

function ok(input: unknown) {
  const result = parseCloudWatchAlarm(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.alert;
}

describe("parseCloudWatchAlarm", () => {
  it("turns an SNS CloudWatch ALARM into a firing alert", () => {
    expect(ok(fixture)).toEqual({
      source: "cloudwatch",
      externalId: "5a1c1d8e-2f43-5b6d-9c1a-0e7f2b3c4d5e",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: "firing",
      severity: "SEV2",
      title: "checkout-api-5xx",
      summary: "Threshold Crossed: 1 datapoint [12.0] was greater than the threshold (5.0).",
      occurredAt: new Date("2026-10-28T09:15:02.123Z"),
    });
  });

  it("treats OK as resolved", () => {
    expect(ok(withMessage({ NewStateValue: "OK" })).status).toBe("resolved");
  });

  it("ignores INSUFFICIENT_DATA rather than opening an incident", () => {
    expect(parseCloudWatchAlarm(withMessage({ NewStateValue: "INSUFFICIENT_DATA" }))).toEqual({
      ok: false,
      error: "ignored state INSUFFICIENT_DATA",
    });
  });

  describe("severity", () => {
    it.each([
      ["[SEV1] db down", "SEV1"],
      ["sev4: noisy disk", "SEV4"],
      ["no tag here", "SEV3"],
      [undefined, "SEV3"],
    ])("description %j gives %s", (description, severity) => {
      expect(ok(withMessage({ AlarmDescription: description })).severity).toBe(severity);
    });
  });

  describe("fingerprint", () => {
    it("is the same for repeated notifications of the same alarm", () => {
      const again = { ...withMessage({ NewStateReason: "different reason", StateChangeTime: "2026-10-28T10:00:00.000+0000" }), MessageId: "other" };
      expect(ok(again).fingerprint).toBe(ok(fixture).fingerprint);
    });

    it("is the same whether the alarm is firing or resolved", () => {
      expect(ok(withMessage({ NewStateValue: "OK" })).fingerprint).toBe(ok(fixture).fingerprint);
    });

    it("differs for a different alarm", () => {
      const other = withMessage({ AlarmArn: "arn:aws:cloudwatch:eu-west-2:123456789012:alarm:other" });
      expect(ok(other).fingerprint).not.toBe(ok(fixture).fingerprint);
    });
  });

  describe("rejects bad input without echoing it", () => {
    it.each([
      ["not an object", "hello"],
      ["wrong SNS type", { ...fixture, Type: "SubscriptionConfirmation" }],
      ["Message is not JSON", { ...fixture, Message: "{not json" }],
      ["missing AlarmArn", withMessage({ AlarmArn: undefined })],
      ["unknown state", withMessage({ NewStateValue: "MAYBE" })],
      ["bad timestamp", withMessage({ StateChangeTime: "yesterday" })],
      ["oversized title", withMessage({ AlarmName: "x".repeat(256) })],
    ])("%s", (_label, input) => {
      const result = parseCloudWatchAlarm(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain("xxxxxxxxxx");
    });
  });
});
