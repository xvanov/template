/**
 * The guard against real Postgres: the outbound_message row is the product,
 * so it is asserted on, not mocked. Counters use an in-memory store.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { memoryStore } from "@repo/security";

import {
  deliver,
  parseSafeList,
  setFrozen,
  suppress,
  type GuardConfig,
} from "./index";

const config = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  safeMode: false,
  safeRecipients: parseSafeList("@safe.test"),
  enabled: { email: true, sms: false, push: false },
  frozen: false,
  caps: {
    recipientPerHour: 3,
    orgPerHour: 100,
    orgPerDay: 100,
    globalPerHour: 100,
  },
  ...over,
});

const addr = (domain = "example.test") =>
  `r-${randomBytes(4).toString("hex")}@${domain}`;
const ok = async () => ({ providerMessageId: "msg-1" });
/** A fresh spy per test: asserting "never called" on a shared one is meaningless. */
const spy = () => vi.fn(ok);
const rowOf = (id: string) =>
  db.outboundMessage.findUniqueOrThrow({ where: { id } });

describe("deliver", () => {
  it("records a sent message BEFORE calling the provider, then marks it sent", async () => {
    const org = await createTenant("ob-sent");
    let statusDuringSend: string | undefined;
    const result = await deliver(
      {
        channel: "email",
        recipient: addr(),
        purpose: "test.sent",
        organizationId: org.organizationId,
      },
      async () => {
        const pending = await db.outboundMessage.findFirstOrThrow({
          where: { purpose: "test.sent", organizationId: org.organizationId },
        });
        statusDuringSend = pending.status;
        return { providerMessageId: "msg-42" };
      },
      { config: config(), store: memoryStore() },
    );
    expect(statusDuringSend).toBe("pending");
    expect(result.status).toBe("sent");
    expect(await rowOf(result.id)).toMatchObject({
      status: "sent",
      providerMessageId: "msg-42",
      organizationId: org.organizationId,
    });
  });

  it("safe mode: never calls the provider for a stranger, and logs why", async () => {
    const send = spy();
    const result = await deliver(
      { channel: "email", recipient: addr(), purpose: "test.safe" },
      send,
      { config: config({ safeMode: true }), store: memoryStore() },
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "blocked", reason: "SAFE_MODE" });
    expect(await rowOf(result.id)).toMatchObject({
      status: "blocked",
      blockReason: "SAFE_MODE",
    });

    const allowed = await deliver(
      { channel: "email", recipient: addr("safe.test"), purpose: "test.safe" },
      ok,
      { config: config({ safeMode: true }), store: memoryStore() },
    );
    expect(allowed.status).toBe("sent");
  });

  it("the runtime kill switch stops everything, including auth mail, until lifted", async () => {
    const send = spy();
    const attempt = {
      channel: "email" as const,
      recipient: addr(),
      purpose: "auth.verify-email",
      authMail: true,
    };
    await setFrozen("email", true, "test");
    try {
      const r = await deliver(attempt, send, {
        config: config({ safeMode: true }),
        store: memoryStore(),
      });
      expect(r).toMatchObject({ status: "blocked", reason: "FROZEN" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await setFrozen("email", false, "test");
    }
    const r = await deliver(attempt, send, {
      config: config({ safeMode: true }),
      store: memoryStore(),
    });
    expect(r.status).toBe("sent");
  });

  it("suppression: global blocks everyone's mail; per-org blocks only that org's", async () => {
    const a = await createTenant("ob-sup-a");
    const b = await createTenant("ob-sup-b");
    const bounced = addr();
    const unsubscribed = addr();
    await suppress({
      channel: "email",
      recipient: bounced.toUpperCase(),
      reason: "hard bounce",
    });
    await suppress({
      channel: "email",
      recipient: unsubscribed,
      reason: "unsubscribed",
      organizationId: a.organizationId,
    });
    const deps = { config: config(), store: memoryStore() };
    const send = (recipient: string, organizationId: string) =>
      deliver(
        { channel: "email", recipient, purpose: "test.sup", organizationId },
        ok,
        deps,
      );

    expect(await send(bounced, b.organizationId)).toMatchObject({
      reason: "SUPPRESSED",
    });
    expect(await send(unsubscribed, a.organizationId)).toMatchObject({
      reason: "SUPPRESSED",
    });
    expect((await send(unsubscribed, b.organizationId)).status).toBe("sent");
  });

  it("volume: the per-recipient cap blocks the 4th message within the hour", async () => {
    const deps = { config: config(), store: memoryStore() };
    const recipient = addr();
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (
          await deliver(
            { channel: "email", recipient, purpose: "test.vol" },
            ok,
            deps,
          )
        ).status,
      );
    }
    expect(statuses).toEqual(["sent", "sent", "sent", "blocked"]);
  });

  it("volume: fails CLOSED when the counters are unreachable", async () => {
    const send = spy();
    const broken = {
      hit: async () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const r = await deliver(
      { channel: "email", recipient: addr(), purpose: "test.vol" },
      send,
      {
        config: config(),
        store: broken,
      },
    );
    expect(r).toMatchObject({
      status: "blocked",
      reason: "VOLUME_UNAVAILABLE",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("a provider error is recorded as failed and rethrown (so jobs retry)", async () => {
    const recipient = addr();
    await expect(
      deliver(
        { channel: "email", recipient, purpose: "test.fail" },
        async () => {
          throw new Error("550 mailbox unavailable");
        },
        { config: config(), store: memoryStore() },
      ),
    ).rejects.toThrow(/550/);
    expect(
      await db.outboundMessage.findFirstOrThrow({ where: { recipient } }),
    ).toMatchObject({
      status: "failed",
      detail: "550 mailbox unavailable",
    });
  });
});
