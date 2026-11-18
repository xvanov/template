/**
 * sendSms through the real guard and real Postgres, Twilio faked. The
 * outbound_message row is the product, so it is what we assert on.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";

import { sendSms, useFakeTwilio, type FakeTwilio } from "./index";

const number = () =>
  `+4477009${String(randomBytes(3).readUIntBE(0, 3) % 100000).padStart(5, "0")}`;

let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.OUTBOUND_SMS_ENABLED = "true";
  process.env.OUTBOUND_SAFE_MODE = "local";
  process.env.TWILIO_FROM_NUMBER = "+15550100000";
  resetEnvCache();
  create = vi.fn(async () => ({ sid: `SM${randomBytes(8).toString("hex")}` }));
  useFakeTwilio({ createMessage: create } as unknown as FakeTwilio);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  useFakeTwilio(undefined);
  for (const k of [
    "OUTBOUND_SMS_ENABLED",
    "OUTBOUND_SAFE_MODE",
    "OUTBOUND_SAFE_RECIPIENTS",
    "TWILIO_FROM_NUMBER",
  ])
    delete process.env[k];
  resetEnvCache();
});

describe("sendSms", () => {
  it("is OFF by default: CHANNEL_DISABLED, and Twilio is never called", async () => {
    delete process.env.OUTBOUND_SMS_ENABLED;
    resetEnvCache();
    const r = await sendSms(
      { to: number(), body: "hello" },
      { purpose: "test.sms" },
    );
    expect(r).toMatchObject({ status: "blocked", reason: "CHANNEL_DISABLED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("local (mail catcher) safe mode is STRICT for texts: a stranger's number is blocked", async () => {
    const r = await sendSms(
      { to: number(), body: "hello" },
      { purpose: "test.sms" },
    );
    expect(r).toMatchObject({ status: "blocked", reason: "SAFE_MODE" });
    expect(create).not.toHaveBeenCalled();
  });

  it("sends an allowlisted number, normalised, and records Twilio's SID", async () => {
    const to = number();
    process.env.OUTBOUND_SAFE_RECIPIENTS = `dev@team.test, ${to}`;
    resetEnvCache();
    const org = await createTenant("sms-send");
    const spaced = `${to.slice(0, 3)} ${to.slice(3, 7)}-${to.slice(7)}`;
    const r = await sendSms(
      { to: spaced, body: "Your booking is confirmed." },
      { purpose: "test.sms", organizationId: org.organizationId },
    );
    expect(r.status).toBe("sent");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ To: to, Body: "Your booking is confirmed." }),
    );
    expect(
      await db.outboundMessage.findUniqueOrThrow({ where: { id: r.id } }),
    ).toMatchObject({
      channel: "sms",
      recipient: to,
      status: "sent",
      providerMessageId: expect.stringMatching(/^SM/),
      organizationId: org.organizationId,
    });
  });
});
