/**
 * push.*: device registration is per tenant and per user (the docs/guide.md
 * org-isolation pattern), idempotent, and a token moves to whoever registers
 * it last (one install, one owner).
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";

import { callerFor } from "./caller";

const token = () => `ExponentPushToken[${randomBytes(11).toString("hex")}]`;

describe("push devices", () => {
  it("registering twice is one device: a heartbeat, audited once", async () => {
    const a = await createTenant("push-idem");
    const tok = token();
    const api = callerFor(a);
    expect(await api.push.register({ token: tok, platform: "ios" })).toEqual({
      registered: true,
      takeover: false,
    });
    await db.pushDevice.updateMany({
      where: { token: tok },
      data: { disabled: true, disabledReason: "DeviceNotRegistered" },
    });
    await api.push.register({ token: tok, platform: "ios" });

    const rows = await db.pushDevice.findMany({ where: { token: tok } });
    expect(rows).toHaveLength(1);
    // A fresh registration re-enables a disabled device.
    expect(rows[0]).toMatchObject({
      organizationId: a.organizationId,
      userId: a.userId,
      disabled: false,
      disabledReason: null,
    });
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: a.organizationId,
          action: "push_device.register",
        },
      }),
    ).toBe(1);
    const listed = await api.push.devices();
    expect(listed).toHaveLength(1);
    // The full token never goes back out.
    expect(listed[0]!.token).not.toBe(tok);
    expect(listed[0]!.token).toMatch(/^ExponentPushToken\[.{4}…\]$/);
  });

  it("B sees none of A's devices, and cannot unregister them", async () => {
    const a = await createTenant("push-a");
    const b = await createTenant("push-b");
    const tok = token();
    await callerFor(a).push.register({ token: tok, platform: "android" });

    expect(await callerFor(b).push.devices()).toEqual([]);
    expect(await callerFor(b).push.unregister({ token: tok })).toEqual({
      removed: 0,
    });
    expect(await db.pushDevice.count({ where: { token: tok } })).toBe(1);

    expect(await callerFor(a).push.unregister({ token: tok })).toEqual({
      removed: 1,
    });
    expect(await db.pushDevice.count({ where: { token: tok } })).toBe(0);
  });

  it("a token registered by someone else moves to them (the phone changed hands)", async () => {
    const a = await createTenant("push-from");
    const b = await createTenant("push-to");
    const tok = token();
    await callerFor(a).push.register({ token: tok, platform: "ios" });
    expect(
      await callerFor(b).push.register({ token: tok, platform: "ios" }),
    ).toEqual({ registered: true, takeover: true });

    expect(await callerFor(a).push.devices()).toEqual([]);
    expect(await callerFor(b).push.devices()).toHaveLength(1);
    expect(
      await db.pushDevice.findUniqueOrThrow({ where: { token: tok } }),
    ).toMatchObject({ organizationId: b.organizationId, userId: b.userId });
  });

  it("refuses anything that is not an Expo push token", async () => {
    const a = await createTenant("push-bad");
    await expect(
      callerFor(a).push.register({ token: "not-a-token", platform: "ios" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("test push is refused while the channel is off (the default)", async () => {
    delete process.env.OUTBOUND_MOBILE_PUSH_ENABLED;
    resetEnvCache();
    const a = await createTenant("push-test");
    await expect(callerFor(a).push.test()).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("the activity log never shows an admin a member's full push token", async () => {
    const a = await createTenant("push-activity");
    const tok = token();
    await db.outboundMessage.create({
      data: {
        organizationId: a.organizationId,
        channel: "mobile_push",
        recipient: tok,
        purpose: "test.push",
        status: "sent",
      },
    });
    await db.outboundMessage.create({
      data: {
        organizationId: a.organizationId,
        channel: "email",
        recipient: "customer@example.test",
        purpose: "test.mail",
        status: "sent",
      },
    });
    const rows = await callerFor(a).activity.outbound();
    const push = rows.find((r) => r.channel === "mobile_push")!;
    expect(push.recipient).not.toBe(tok);
    expect(push.recipient).toMatch(/^ExponentPushToken\[.{4}…\]$/);
    expect(JSON.stringify(rows)).not.toContain(tok.slice(22, -1));
    expect(rows.find((r) => r.channel === "email")!.recipient).toBe(
      "customer@example.test",
    );
  });

  // @module:agent
  it("agent.proposal (what a proposal push opens) is org-scoped", async () => {
    const a = await createTenant("push-open-a");
    const b = await createTenant("push-open-b");
    const p = await db.agentProposal.create({
      data: {
        organizationId: a.organizationId,
        proposedById: a.userId,
        source: "user",
        tool: "items_create",
        input: {},
        summary: "Create item “Desk”",
      },
      select: { id: true },
    });
    expect(await callerFor(a).agent.proposal({ id: p.id })).toMatchObject({
      id: p.id,
      status: "pending",
    });
    await expect(
      callerFor(b).agent.proposal({ id: p.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  // @end
});
