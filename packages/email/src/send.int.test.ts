/**
 * sendMail end to end through the real guard and real Postgres. SMTP_HOST is
 * unset, so an allowed message is printed instead of sent (the template's
 * no-infrastructure mode) — which is also how we see whether it got through.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { resetEnvCache } from "@repo/env";

import { sendAuthMail, sendMail, verificationEmail } from "./index";

const LINK = "https://app.example.com/api/auth/verify-email?token=abc.def";
const stranger = () =>
  `user-${randomBytes(4).toString("hex")}@real-customer.example`;

let printed: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env.SMTP_HOST;
  process.env.OUTBOUND_SAFE_MODE = "true";
  process.env.OUTBOUND_SAFE_RECIPIENTS = "@team.example";
  resetEnvCache();
  printed = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OUTBOUND_SAFE_MODE;
  delete process.env.OUTBOUND_SAFE_RECIPIENTS;
  resetEnvCache();
});

describe("sendMail", () => {
  it("in safe mode, app mail to a stranger is blocked, never printed, and logged", async () => {
    const to = stranger();
    const result = await sendMail(
      { to, subject: "Your weekly digest", text: "hello" },
      { purpose: "test.digest" },
    );
    expect(result).toMatchObject({ status: "blocked", reason: "SAFE_MODE" });
    expect(printed).not.toHaveBeenCalled();
    expect(
      await db.outboundMessage.findFirstOrThrow({ where: { recipient: to } }),
    ).toMatchObject({
      status: "blocked",
      purpose: "test.digest",
      subject: "Your weekly digest",
    });
  });

  it("in safe mode, app mail to an allowlisted domain goes out", async () => {
    const result = await sendMail(
      { to: "dev@team.example", subject: "s", text: "body" },
      { purpose: "test.digest" },
    );
    expect(result.status).toBe("sent");
  });

  it("auth mail to the address that just signed up gets through safe mode, link intact", async () => {
    const to = stranger();
    const result = await sendAuthMail(
      { to, ...verificationEmail(LINK) },
      "auth.verify-email",
    );
    expect(result).toMatchObject({
      status: "sent",
      detail: "logged to console (SMTP_HOST unset)",
    });
    // The link must be recoverable from the terminal, or the fallback is useless.
    expect(printed.mock.calls.flat().join("\n")).toContain(LINK);
    expect(
      await db.outboundMessage.findFirstOrThrow({ where: { recipient: to } }),
    ).toMatchObject({
      status: "sent",
      purpose: "auth.verify-email",
      organizationId: null,
    });
  });

  it("refuses a non-loopback SMTP host under test, and records the failure", async () => {
    process.env.SMTP_HOST = "smtp.real-relay.example";
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const to = stranger();
    await expect(
      sendMail({ to, subject: "s", text: "t" }, { purpose: "test.relay" }),
    ).rejects.toThrow(/only a loopback mail catcher/);
    expect(
      await db.outboundMessage.findFirstOrThrow({ where: { recipient: to } }),
    ).toMatchObject({ status: "failed" });
  });
});
