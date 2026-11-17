/**
 * The SMTP transport is built with bounded timeouts. nodemailer is mocked:
 * nothing is sent, we only read what the transport was configured with.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@repo/env";

import { transmit } from "./transport";

const { createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: "m1" }));
  return { createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ createTransport }));

afterEach(() => {
  delete process.env.SMTP_HOST;
  resetEnvCache();
});

describe("SMTP transport", () => {
  it("connects, greets and idles with 30s timeouts, not nodemailer's minutes", async () => {
    process.env.SMTP_HOST = "127.0.0.1";
    resetEnvCache();
    await transmit({ to: "a@b.test", subject: "s", text: "t" });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 30_000,
      }),
    );
  });
});
