/**
 * sendMobilePush through the real guard and real Postgres, Expo faked. The
 * outbound_message and push_device rows are the product, so they are what
 * we assert on.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";

import {
  checkMobilePushReceipts,
  notifyAppEvent,
  sendMobilePush,
  useFakeExpoFetch,
} from "./index";

type Msg = { to: string };
let sent: Msg[];
let ticketFor: (m: Msg) => unknown;
let receiptFor: (id: string) => unknown;

const ENV = [
  "OUTBOUND_MOBILE_PUSH_ENABLED",
  "OUTBOUND_SAFE_MODE",
  "OUTBOUND_SAFE_RECIPIENTS",
];

beforeEach(() => {
  process.env.OUTBOUND_MOBILE_PUSH_ENABLED = "true";
  process.env.OUTBOUND_SAFE_MODE = "local";
  resetEnvCache();
  sent = [];
  ticketFor = () => ({
    status: "ok",
    id: `tk_${randomBytes(6).toString("hex")}`,
  });
  receiptFor = () => ({ status: "ok" });
  useFakeExpoFetch(async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/send")) {
      sent.push(...(body as Msg[]));
      return Response.json({ data: (body as Msg[]).map((m) => ticketFor(m)) });
    }
    return Response.json({
      data: Object.fromEntries(
        (body as { ids: string[] }).ids.map((id) => [id, receiptFor(id)]),
      ),
    });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  useFakeExpoFetch(undefined);
  for (const k of ENV) delete process.env[k];
  resetEnvCache();
});

const token = () => `ExponentPushToken[${randomBytes(11).toString("hex")}]`;

async function device(t: TestTenant, tok = token()) {
  await db.pushDevice.create({
    data: {
      organizationId: t.organizationId,
      userId: t.userId,
      token: tok,
      platform: "ios",
    },
  });
  return tok;
}

const push = { title: "Test", body: "Hello" };
const to = (t: TestTenant) => ({
  userId: t.userId,
  organizationId: t.organizationId,
});

describe("sendMobilePush", () => {
  it("is OFF by default: CHANNEL_DISABLED, nothing reaches Expo", async () => {
    delete process.env.OUTBOUND_MOBILE_PUSH_ENABLED;
    resetEnvCache();
    const t = await createTenant("mp-off");
    await device(t);
    const r = await sendMobilePush(to(t), push, { purpose: "test.push" });
    expect(r).toMatchObject({ devices: 1, sent: 0, blocked: 1 });
    expect(sent).toEqual([]);
  });

  it("local (mail catcher) safe mode is STRICT for pushes: an unlisted owner is blocked", async () => {
    const t = await createTenant("mp-strict");
    await device(t);
    const r = await sendMobilePush(to(t), push, { purpose: "test.push" });
    expect(r).toMatchObject({ sent: 0, blocked: 1 });
    expect(sent).toEqual([]);
    const row = await db.outboundMessage.findFirstOrThrow({
      where: { organizationId: t.organizationId, channel: "mobile_push" },
    });
    expect(row).toMatchObject({ status: "blocked", blockReason: "SAFE_MODE" });
  });

  it("strict mode lets a device through by its owner's VERIFIED email (or @domain)", async () => {
    const t = await createTenant("mp-owner");
    const tok = await device(t);
    process.env.OUTBOUND_SAFE_RECIPIENTS = "@example.test";
    resetEnvCache();
    const r = await sendMobilePush(to(t), push, { purpose: "test.push" });
    expect(r).toMatchObject({ devices: 1, sent: 1, blocked: 0 });
    expect(sent.map((m) => m.to)).toEqual([tok]);

    // The same owner, unverified: the address proves nothing, blocked.
    await db.user.update({
      where: { id: t.userId },
      data: { emailVerified: false },
    });
    const again = await sendMobilePush(to(t), push, { purpose: "test.push" });
    expect(again).toMatchObject({ sent: 0, blocked: 1 });
  });

  it("strict mode lets a device through by its exact token", async () => {
    const t = await createTenant("mp-token");
    const tok = await device(t);
    process.env.OUTBOUND_SAFE_RECIPIENTS = `someone@else.test, ${tok}`;
    resetEnvCache();
    const r = await sendMobilePush(to(t), push, { purpose: "test.push" });
    expect(r.sent).toBe(1);
  });

  it("one request for all of a user's devices; a retry with the same key sends nothing again", async () => {
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const t = await createTenant("mp-batch");
    await device(t);
    await device(t);
    await device(t);
    const ctx = { purpose: "test.push", idempotencyKey: "evt:1" };
    expect(await sendMobilePush(to(t), push, ctx)).toMatchObject({ sent: 3 });
    expect(sent).toHaveLength(3);
    expect(await sendMobilePush(to(t), push, ctx)).toMatchObject({ sent: 3 });
    expect(sent).toHaveLength(3); // nothing new left
  });

  it("DeviceNotRegistered on a ticket disables that device and spares the rest", async () => {
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const t = await createTenant("mp-dnr");
    const dead = await device(t);
    await device(t);
    ticketFor = (m) =>
      m.to === dead
        ? {
            status: "error",
            message: "gone",
            details: { error: "DeviceNotRegistered" },
          }
        : { status: "ok", id: `tk_${randomBytes(6).toString("hex")}` };
    const r = await sendMobilePush(to(t), push, { purpose: "test.push" });
    expect(r).toMatchObject({ devices: 2, sent: 1, disabled: 1 });
    expect(
      await db.pushDevice.findUniqueOrThrow({ where: { token: dead } }),
    ).toMatchObject({ disabled: true, disabledReason: "DeviceNotRegistered" });
    // Disabled devices are skipped from now on.
    expect(
      await sendMobilePush(to(t), push, { purpose: "test.push" }),
    ).toMatchObject({ devices: 1 });
  });

  it("skips a device whose owner left the organization", async () => {
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const t = await createTenant("mp-left");
    await device(t);
    await db.member.deleteMany({
      where: { userId: t.userId, organizationId: t.organizationId },
    });
    expect(
      await sendMobilePush(to(t), push, { purpose: "test.push" }),
    ).toMatchObject({ devices: 0, sent: 0 });
  });
});

describe("checkMobilePushReceipts", () => {
  it("records receipts and disables devices Expo reports as DeviceNotRegistered", async () => {
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const t = await createTenant("mp-receipts");
    const dead = await device(t);
    const alive = await device(t);
    await sendMobilePush(to(t), push, { purpose: "test.push" });
    const rows = await db.outboundMessage.findMany({
      where: { organizationId: t.organizationId, channel: "mobile_push" },
      select: { id: true, recipient: true, providerMessageId: true },
    });
    expect(rows).toHaveLength(2);
    const deadTicket = rows.find(
      (r) => r.recipient === dead,
    )!.providerMessageId!;
    receiptFor = (id) =>
      id === deadTicket
        ? {
            status: "error",
            message: "gone",
            details: { error: "DeviceNotRegistered" },
          }
        : { status: "ok" };

    // Receipts are asked for 15 minutes after sending.
    const r = await checkMobilePushReceipts({
      now: new Date(Date.now() + 16 * 60_000),
    });
    expect(r.checked).toBeGreaterThanOrEqual(2);
    const after = await db.outboundMessage.findMany({
      where: { id: { in: rows.map((x) => x.id) } },
      select: { recipient: true, deliveryStatus: true, deliveryDetail: true },
    });
    expect(after.find((x) => x.recipient === dead)).toMatchObject({
      deliveryStatus: "undelivered",
      deliveryDetail: "DeviceNotRegistered: gone",
    });
    expect(after.find((x) => x.recipient === alive)?.deliveryStatus).toBe(
      "sent",
    );
    expect(
      (await db.pushDevice.findUniqueOrThrow({ where: { token: dead } }))
        .disabled,
    ).toBe(true);
    expect(
      (await db.pushDevice.findUniqueOrThrow({ where: { token: alive } }))
        .disabled,
    ).toBe(false);
  });
});

describe("notifyAppEvent", () => {
  it("pushes a pending proposal to the user it was made for, generic text only", async () => {
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const t = await createTenant("mp-proposal");
    const tok = await device(t);
    const p = await db.agentProposal.create({
      data: {
        organizationId: t.organizationId,
        proposedById: t.userId,
        source: "user",
        tool: "items_create",
        input: { title: "Call ACME about the overdue invoice" },
        summary: "Create item: Call ACME about the overdue invoice",
      },
    });
    const r = await notifyAppEvent(t.organizationId, {
      kind: "proposal",
      id: p.id,
    });
    expect(r).toMatchObject({ users: 1, sent: 1 });
    const m = sent.find((x) => x.to === tok) as unknown as {
      title: string;
      body: string;
    };
    expect(m.title).toBe("Waiting for your approval");
    expect(JSON.stringify(m)).not.toContain("ACME");

    // Decided already: nothing to push.
    await db.agentProposal.update({
      where: { id: p.id },
      data: { status: "rejected" },
    });
    expect(
      await notifyAppEvent(t.organizationId, { kind: "proposal", id: p.id }),
    ).toMatchObject({ skipped: "not pending" });
  });

  it("does nothing for another tenant's event id", async () => {
    process.env.OUTBOUND_SAFE_MODE = "false";
    resetEnvCache();
    const a = await createTenant("mp-a");
    const b = await createTenant("mp-b");
    await device(b);
    const p = await db.agentProposal.create({
      data: {
        organizationId: a.organizationId,
        proposedById: a.userId,
        source: "user",
        tool: "items_create",
        input: {},
        summary: "x",
      },
    });
    expect(
      await notifyAppEvent(b.organizationId, { kind: "proposal", id: p.id }),
    ).toMatchObject({ skipped: "not pending", sent: 0 });
    expect(sent).toEqual([]);
  });
});
