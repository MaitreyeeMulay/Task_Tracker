import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "./provider";
import { classifySesError, createSesProvider } from "./ses";

const message: EmailMessage = {
  notificationId: "11111111-1111-1111-1111-111111111111",
  incidentId: "22222222-2222-2222-2222-222222222222",
  to: "responder@example.com",
  subject: "INC-1001 needs acknowledgement",
  text: "Body text",
};

function sdkError(name: string, status?: number): Error {
  return Object.assign(new Error(`${name} details`), { name, $metadata: { httpStatusCode: status } });
}

afterEach(() => vi.restoreAllMocks());

describe("createSesProvider", () => {
  it("sends from the configured address and reports SES's message id", async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: "ses-123" });
    const provider = createSesProvider({ send, from: "alerts@example.com" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await provider(message)).toEqual({ outcome: "delivered", messageId: "ses-123" });
    expect(send).toHaveBeenCalledWith({
      FromEmailAddress: "alerts@example.com",
      Destination: { ToAddresses: ["responder@example.com"] },
      Content: { Simple: { Subject: { Data: message.subject, Charset: "UTF-8" }, Body: { Text: { Data: message.text, Charset: "UTF-8" } } } },
    });
  });

  it("treats a success without a message id as unknown, so a person checks it", async () => {
    const provider = createSesProvider({ send: vi.fn().mockResolvedValue({}), from: "alerts@example.com" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await provider(message)).toEqual({ outcome: "unknown", code: "no_message_id" });
  });

  it("turns a thrown error into a send result instead of crashing the worker", async () => {
    const provider = createSesProvider({ send: vi.fn().mockRejectedValue(sdkError("MessageRejected", 400)), from: "alerts@example.com" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await provider(message)).toEqual({ outcome: "rejected", code: "MessageRejected", permanent: true });
  });

  it("logs ids and the outcome only, never the address, subject or text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = createSesProvider({ send: vi.fn().mockResolvedValue({ MessageId: "ses-123" }), from: "alerts@example.com" });
    await provider(message);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain(message.notificationId);
    for (const text of [message.to, message.subject, message.text, "alerts@example.com"]) expect(logged).not.toContain(text);
  });
});

describe("classifySesError", () => {
  it.each(["TooManyRequestsException", "LimitExceededException", "ThrottlingException"])("retries %s later: SES refused it, nothing was sent", (name) => {
    expect(classifySesError(sdkError(name, 429))).toEqual({ outcome: "rejected", code: name });
  });

  it.each(["MessageRejected", "MailFromDomainNotVerifiedException", "AccountSuspendedException", "SendingPausedException", "BadRequestException", "NotFoundException"])(
    "fails %s for good: sending again won't help",
    (name) => {
      expect(classifySesError(sdkError(name, 400))).toEqual({ outcome: "rejected", code: name, permanent: true });
    },
  );

  it.each([
    ["a server error", sdkError("InternalFailure", 500)],
    ["a network timeout", sdkError("TimeoutError")],
    ["something that isn't an error", "boom"],
  ])("sends %s to a person, because the email may already have gone out", (_label, error) => {
    expect(classifySesError(error)).toMatchObject({ outcome: "unknown" });
  });

  it("never puts the error message in the code, since it can quote the address", () => {
    const result = classifySesError(Object.assign(new Error("Email address is not verified: responder@example.com"), { name: "MessageRejected" }));
    expect(JSON.stringify(result)).not.toContain("responder@example.com");
  });
});
