/**
 * The transports, with their SDKs faked: nothing leaves the process. We check
 * what each is configured with and handed, not whether mail arrives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@repo/env";

import {
  domainOf,
  messageIdFor,
  transmit,
  useFakeResend,
  type FakeResend,
} from "./transport";

const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({
    messageId: "m1",
  }));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ createTransport }));

const meta = { messageId: "cmrow123" };

afterEach(() => {
  delete process.env.SMTP_HOST;
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  useFakeResend(undefined);
  resetEnvCache();
});

function fakeResend(
  result: { data: { id: string } | null; error: unknown } = {
    data: { id: "re_1" },
    error: null,
  },
) {
  const send = vi.fn(async () => result);
  const fake = { emails: { send } } as unknown as FakeResend;
  return { fake, send };
}

describe("SMTP transport", () => {
  it("connects, greets and idles with 30s timeouts, not nodemailer's minutes", async () => {
    process.env.SMTP_HOST = "127.0.0.1";
    resetEnvCache();
    await transmit({ to: "a@b.test", subject: "s", text: "t" }, meta);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 30_000,
      }),
    );
  });

  it("stamps the row's Message-ID and drops headers that would add recipients", async () => {
    process.env.SMTP_HOST = "127.0.0.1";
    resetEnvCache();
    await transmit(
      {
        to: "a@b.test",
        subject: "s",
        text: "t",
        headers: {
          "In-Reply-To": "<x@y>",
          Bcc: "stranger@else.test",
          "Message-ID": "<forged@x>",
          "X-Evil": "a\r\nBcc: stranger@else.test",
        },
      },
      meta,
    );
    const opts = sendMail.mock.calls.at(-1)![0];
    expect(opts.messageId).toBe("<obm.cmrow123@localhost>");
    expect(opts.headers).toEqual({ "In-Reply-To": "<x@y>" });
  });
});

describe("Resend transport", () => {
  it("is refused under test unless a fake is installed (no network in make test)", async () => {
    process.env.EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_live_looking_key";
    resetEnvCache();
    await expect(
      transmit({ to: "a@b.test", subject: "s", text: "t" }, meta),
    ).rejects.toThrow(/Refusing to call Resend/);
  });

  it("sends one recipient, the row's Message-ID, and the row id as Idempotency-Key", async () => {
    process.env.EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_test";
    process.env.SMTP_FROM = "Acme <hello@mail.acme.test>";
    resetEnvCache();
    const { fake, send } = fakeResend();
    useFakeResend(fake);
    const receipt = await transmit(
      { to: "a@b.test", subject: "s", text: "t", html: "<p>t</p>" },
      meta,
    );
    expect(receipt).toEqual({ providerMessageId: "re_1" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Acme <hello@mail.acme.test>",
        to: ["a@b.test"],
        html: "<p>t</p>",
        headers: { "Message-ID": "<obm.cmrow123@mail.acme.test>" },
      }),
      { idempotencyKey: "outbound-message/cmrow123" },
    );
    delete process.env.SMTP_FROM;
  });

  it("an API error becomes a thrown error (the guard records it as failed)", async () => {
    process.env.EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_test";
    resetEnvCache();
    useFakeResend(
      fakeResend({
        data: null,
        error: { name: "validation_error", message: "bad from" },
      }).fake,
    );
    await expect(
      transmit({ to: "a@b.test", subject: "s", text: "t" }, meta),
    ).rejects.toThrow(/validation_error: bad from/);
  });
});

describe("Message-ID", () => {
  it("is built from the From domain", () => {
    expect(domainOf("App <no-reply@Example.COM>")).toBe("example.com");
    expect(domainOf("bare@x.test")).toBe("x.test");
    expect(messageIdFor("abc", "A <a@b.test>")).toBe("<obm.abc@b.test>");
  });
});
