import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/sns-cloudwatch-alarm.json" with { type: "json" };
import { isTrustedSnsUrl, snsStringToSign, verifySnsMessage, type SnsMessage } from "./sns.ts";

const TOPIC = fixture.TopicArn;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function signed(message: Omit<SnsMessage, "Signature">, key = privateKey): SnsMessage {
  const signature = createSign("RSA-SHA256").update(snsStringToSign(message as SnsMessage)).sign(key, "base64");
  return { ...message, Signature: signature } as SnsMessage;
}

const notification = signed(fixture as SnsMessage);
const fetchCert = async () => PUBLIC_PEM;

describe("snsStringToSign", () => {
  it("lists Notification fields in AWS's documented order", () => {
    expect(snsStringToSign({ ...notification, Subject: "S" })).toBe(
      `Message\n${fixture.Message}\nMessageId\n${fixture.MessageId}\nSubject\nS\nTimestamp\n${fixture.Timestamp}\nTopicArn\n${TOPIC}\nType\nNotification\n`,
    );
  });

  it("omits Subject when absent", () => {
    const noSubject: SnsMessage = { ...notification };
    delete noSubject.Subject;
    expect(snsStringToSign(noSubject)).not.toContain("Subject\n");
  });

  it("uses SubscribeURL and Token for subscription confirmations", () => {
    const text = snsStringToSign({
      Type: "SubscriptionConfirmation",
      Message: "m",
      MessageId: "id",
      SubscribeURL: "https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription",
      Timestamp: "t",
      Token: "tok",
      TopicArn: TOPIC,
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: fixture.SigningCertURL,
    });
    expect(text).toBe(
      `Message\nm\nMessageId\nid\nSubscribeURL\nhttps://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription\nTimestamp\nt\nToken\ntok\nTopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`,
    );
  });
});

describe("isTrustedSnsUrl", () => {
  it.each([
    "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.us-east-1.amazonaws.com/x.pem",
    "https://sns.cn-north-1.amazonaws.com.cn/x.pem",
  ])("trusts %s", (url) => {
    expect(isTrustedSnsUrl(url)).toBe(true);
  });

  it.each([
    ["plain http", "http://sns.eu-west-2.amazonaws.com/x.pem"],
    ["look-alike host", "https://sns.eu-west-2.amazonaws.com.evil.example/x.pem"],
    ["attacker subdomain", "https://evil.sns.eu-west-2.amazonaws.com/x.pem"],
    ["other AWS service", "https://s3.eu-west-2.amazonaws.com/x.pem"],
    ["user info trick", "https://sns.eu-west-2.amazonaws.com@evil.example/x.pem"],
    ["explicit port", "https://sns.eu-west-2.amazonaws.com:8443/x.pem"],
    ["not a URL", "sns.eu-west-2.amazonaws.com"],
    ["internal address", "https://169.254.169.254/latest/meta-data"],
  ])("rejects %s", (_label, url) => {
    expect(isTrustedSnsUrl(url)).toBe(false);
  });
});

describe("verifySnsMessage", () => {
  const options = { expectedTopicArn: TOPIC, fetchCert };

  it("accepts a correctly signed message from the expected topic", async () => {
    expect(await verifySnsMessage(notification, options)).toEqual({ ok: true });
  });

  it("rejects a message from a different topic, even if AWS signed it", async () => {
    const other = signed({ ...notification, TopicArn: "arn:aws:sns:eu-west-2:999999999999:attacker-topic" });
    expect(await verifySnsMessage(other, options)).toEqual({ ok: false, reason: "unexpected_topic" });
  });

  it("rejects a tampered message", async () => {
    expect(await verifySnsMessage({ ...notification, Message: '{"AlarmName":"fake"}' }, options)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a message signed with a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(await verifySnsMessage(signed(fixture as SnsMessage, other), options)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects SignatureVersion 1 (SHA-1)", async () => {
    expect(await verifySnsMessage({ ...notification, SignatureVersion: "1" }, options)).toEqual({
      ok: false,
      reason: "unsupported_signature_version",
    });
  });

  it("never fetches a certificate from an untrusted URL", async () => {
    let fetched = false;
    const result = await verifySnsMessage(
      { ...notification, SigningCertURL: "https://evil.example/cert.pem" },
      { expectedTopicArn: TOPIC, fetchCert: async () => ((fetched = true), PUBLIC_PEM) },
    );
    expect(result).toEqual({ ok: false, reason: "untrusted_cert_url" });
    expect(fetched).toBe(false);
  });

  it("checks the topic before fetching anything", async () => {
    let fetched = false;
    await verifySnsMessage(
      { ...notification, TopicArn: "arn:aws:sns:eu-west-2:999999999999:attacker-topic" },
      { expectedTopicArn: TOPIC, fetchCert: async () => ((fetched = true), PUBLIC_PEM) },
    );
    expect(fetched).toBe(false);
  });

  it("reports a certificate fetch failure without throwing", async () => {
    const result = await verifySnsMessage(notification, {
      expectedTopicArn: TOPIC,
      fetchCert: async () => {
        throw new Error("timeout");
      },
    });
    expect(result).toEqual({ ok: false, reason: "cert_unavailable" });
  });

  it("rejects a malformed message", async () => {
    expect(await verifySnsMessage({ Type: "Notification" }, options)).toEqual({ ok: false, reason: "malformed" });
  });
});
