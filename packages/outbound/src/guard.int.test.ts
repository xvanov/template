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
  PENDING_STALE_MS,
  recordDeliveryStatus,
  setFrozen,
  suppress,
  unsuppress,
  type DeliveryResult,
  type GuardConfig,
  type GuardDeps,
} from "./index";

const config = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  safeMode: "off",
  safeRecipients: parseSafeList("@safe.test"),
  enabled: { email: true, push: true, sms: true, mobile_push: true },
  operatorRecipients: {},
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
      { config: config({ safeMode: "strict" }), store: memoryStore() },
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
      { config: config({ safeMode: "strict" }), store: memoryStore() },
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
        config: config({ safeMode: "strict" }),
        store: memoryStore(),
      });
      expect(r).toMatchObject({ status: "blocked", reason: "FROZEN" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await setFrozen("email", false, "test");
    }
    const r = await deliver(attempt, send, {
      config: config({ safeMode: "strict" }),
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

  it("a recipient LIST is blocked as INVALID_RECIPIENT, even when part of it is allowlisted", async () => {
    const send = spy();
    const raw = `${addr("gmail.test")}, me@safe.test`;
    const r = await deliver(
      { channel: "email", recipient: raw, purpose: "test.list" },
      send,
      {
        config: config({ safeMode: "strict" }),
        store: memoryStore(),
      },
    );
    expect(r).toMatchObject({ status: "blocked", reason: "INVALID_RECIPIENT" });
    expect(send).not.toHaveBeenCalled();
    expect(await rowOf(r.id)).toMatchObject({
      recipient: raw,
      blockReason: "INVALID_RECIPIENT",
    });
  });

  it("hands the transport the PARSED address, and caps/logs that one", async () => {
    const send = spy();
    const r = await deliver(
      {
        channel: "email",
        recipient: "  Mixed.Case@Safe.TEST ",
        purpose: "test.parse",
      },
      send,
      { config: config({ safeMode: "strict" }), store: memoryStore() },
    );
    // ...and the row id, which providers get as their idempotency key.
    expect(send).toHaveBeenCalledWith("mixed.case@safe.test", {
      messageId: r.id,
    });
    expect(await rowOf(r.id)).toMatchObject({
      recipient: "mixed.case@safe.test",
    });
  });

  it("once the provider accepted it, a failure to RECORD 'sent' still returns sent (no retry, no duplicate)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = {
      appSetting: db.appSetting,
      outboundSuppression: db.outboundSuppression,
      outboundMessage: {
        create: db.outboundMessage.create.bind(db.outboundMessage),
        updateMany: async () => {
          throw new Error("db went away");
        },
      },
    } as unknown as GuardDeps["db"];
    const send = spy();
    const r = await deliver(
      { channel: "email", recipient: addr(), purpose: "test.flaky" },
      send,
      {
        db: flaky,
        config: config(),
        store: memoryStore(),
      },
    );
    expect(r.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await rowOf(r.id)).toMatchObject({ status: "pending" });
    error.mockRestore();
  });

  it("idempotency key: a retry after a send sends nothing; after a failure it reuses the row and the provider key", async () => {
    const key = `test.idem.${randomBytes(6).toString("hex")}`;
    const deps = { config: config(), store: memoryStore() };
    const attempt = {
      channel: "email" as const,
      recipient: addr(),
      purpose: "test.idem",
      idempotencyKey: key,
    };
    const keysSeen: string[] = [];

    // 1st try: the provider fails after we called it.
    await expect(
      deliver(
        attempt,
        async (_to, meta) => {
          keysSeen.push(meta.messageId);
          throw new Error("timeout");
        },
        deps,
      ),
    ).rejects.toThrow("timeout");

    // 2nd try (the job retry): same row, same provider key, now sent.
    const second = await deliver(
      attempt,
      async (_to, meta) => {
        keysSeen.push(meta.messageId);
        return { providerMessageId: "prov-1" };
      },
      deps,
    );
    expect(second.status).toBe("sent");
    expect(keysSeen).toEqual([second.id, second.id]);

    // 3rd try: already sent, so the provider is not called at all.
    const send = spy();
    const third = await deliver(attempt, send, deps);
    expect(send).not.toHaveBeenCalled();
    expect(third).toMatchObject({ status: "sent", id: second.id });
    expect(
      await db.outboundMessage.count({ where: { idempotencyKey: key } }),
    ).toBe(1);
  });

  /**
   * A fake provider that accepts at once but does not RETURN until released:
   * the winner holds its fresh "pending" claim while every other caller
   * looks, so what they see is fixed, not a matter of scheduling.
   */
  function heldProvider() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let accepted = 0;
    const send = async () => {
      accepted++;
      await gate;
      return { providerMessageId: `<m${accepted}@relay>` };
    };
    return { send, release, accepted: () => accepted };
  }

  /** Run `n` deliveries; release the provider once all but one returned. */
  async function race(
    n: number,
    run: () => Promise<DeliveryResult>,
    release: () => void,
  ) {
    let settled = 0;
    const all = Array.from({ length: n }, () =>
      run().finally(() => {
        settled++;
      }),
    );
    await vi.waitFor(() => expect(settled).toBe(n - 1), { timeout: 5000 });
    release();
    return Promise.all(all);
  }

  it("idempotency key: concurrent attempts send once", async () => {
    const key = `test.race.${randomBytes(6).toString("hex")}`;
    const deps = { config: config(), store: memoryStore() };
    const provider = heldProvider();
    const attempt = {
      channel: "email" as const,
      recipient: addr(),
      purpose: "test.race",
      idempotencyKey: key,
    };
    const results = await race(
      2,
      () => deliver(attempt, provider.send, deps),
      provider.release,
    );
    expect(provider.accepted()).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([
      "in_progress",
      "sent",
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it("idempotency key: concurrent RETRIES after a failure send once", async () => {
    const key = `test.retry-race.${randomBytes(6).toString("hex")}`;
    const deps = { config: config(), store: memoryStore() };
    const attempt = {
      channel: "email" as const,
      recipient: addr(),
      purpose: "test.retry-race",
      idempotencyKey: key,
    };
    await expect(
      deliver(
        attempt,
        async () => {
          throw new Error("421 try later");
        },
        deps,
      ),
    ).rejects.toThrow("421");

    const provider = heldProvider();
    const results = await race(
      4,
      () => deliver(attempt, provider.send, deps),
      provider.release,
    );
    expect(provider.accepted()).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([
      "in_progress",
      "in_progress",
      "in_progress",
      "sent",
    ]);
  });

  it("idempotency key: a slow sender that lost its claim cannot overwrite the takeover", async () => {
    const key = `test.late.${randomBytes(6).toString("hex")}`;
    const deps = { config: config(), store: memoryStore() };
    const attempt = {
      channel: "email" as const,
      recipient: addr(),
      purpose: "test.late",
      idempotencyKey: key,
    };
    // A claims the row and hangs inside the provider...
    let failA!: (e: Error) => void;
    let aCalled!: () => void;
    const aInProvider = new Promise<void>((r) => (aCalled = r));
    const a = deliver(
      attempt,
      () =>
        new Promise((_, reject) => {
          failA = reject;
          aCalled();
        }),
      deps,
    );
    await aInProvider;

    // ...long enough for its claim to go stale: B takes over and sends.
    const later = () => new Date(Date.now() + PENDING_STALE_MS + 60_000);
    const b = await deliver(attempt, ok, { ...deps, now: later });
    expect(b.status).toBe("sent");

    // A's provider call finally fails. Its write must change nothing.
    failA(new Error("timeout after 6 minutes"));
    await expect(a).rejects.toThrow("timeout");
    expect(await rowOf(b.id)).toMatchObject({
      status: "sent",
      providerMessageId: "msg-1",
    });

    // So the next retry sees "sent" and does not send again.
    const send = spy();
    expect(await deliver(attempt, send, { ...deps, now: later })).toMatchObject(
      { status: "sent", id: b.id },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("idempotency key: a pending row is in progress until stale, then a retry takes it", async () => {
    const key = `test.stale.${randomBytes(6).toString("hex")}`;
    const recipient = addr();
    const attempt = {
      channel: "email" as const,
      recipient,
      purpose: "test.stale",
      idempotencyKey: key,
    };
    // A sender that died after claiming the row (the provider may or may not
    // have got it: we cannot know).
    const claimedAt = new Date();
    const row = await db.outboundMessage.create({
      data: {
        channel: "email",
        recipient,
        purpose: "test.stale",
        status: "pending",
        claimedAt,
        idempotencyKey: key,
        idempotencyScope: "system",
      },
    });
    const send = spy();
    const fresh = await deliver(attempt, send, {
      config: config(),
      store: memoryStore(),
    });
    expect(fresh).toMatchObject({ status: "in_progress", id: row.id });
    expect(send).not.toHaveBeenCalled();

    const later = await deliver(attempt, send, {
      config: config(),
      store: memoryStore(),
      now: () => new Date(claimedAt.getTime() + PENDING_STALE_MS + 1000),
    });
    expect(later).toMatchObject({ status: "sent", id: row.id });
    expect(send).toHaveBeenCalledWith(recipient, { messageId: row.id });
  });

  it("idempotency key: reuse for another channel or recipient is a ConflictError and sends nothing", async () => {
    const org = await createTenant("ob-idem-conflict");
    const key = `test.conflict.${randomBytes(6).toString("hex")}`;
    const deps = { config: config(), store: memoryStore() };
    await deliver(
      {
        channel: "sms",
        recipient: "+447700900123",
        purpose: "test.conflict",
        organizationId: org.organizationId,
        idempotencyKey: key,
      },
      ok,
      deps,
    );
    const send = spy();
    for (const other of [
      { channel: "email" as const, recipient: addr() },
      { channel: "sms" as const, recipient: "+447700900999" },
    ]) {
      await expect(
        deliver(
          {
            ...other,
            purpose: "test.conflict",
            organizationId: org.organizationId,
            idempotencyKey: key,
          },
          send,
          deps,
        ),
      ).rejects.toMatchObject({ name: "ConflictError" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("idempotency keys are per tenant: another org's identical key is its own message", async () => {
    const a = await createTenant("ob-idem-a");
    const b = await createTenant("ob-idem-b");
    const key = `test.scope.${randomBytes(6).toString("hex")}`;
    const deps = { config: config(), store: memoryStore() };
    const ra = await deliver(
      {
        channel: "sms",
        recipient: "+447700900123",
        purpose: "test.scope",
        organizationId: a.organizationId,
        idempotencyKey: key,
      },
      ok,
      deps,
    );
    const send = spy();
    const rb = await deliver(
      {
        channel: "email",
        recipient: addr(),
        purpose: "test.scope",
        organizationId: b.organizationId,
        idempotencyKey: key,
      },
      send,
      deps,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(rb.status).toBe("sent");
    expect(rb.id).not.toBe(ra.id);
    expect(await rowOf(rb.id)).toMatchObject({
      organizationId: b.organizationId,
      channel: "email",
    });
  });

  it("delivery status: recorded by provider id, never moved backwards", async () => {
    const providerMessageId = `sm-${randomBytes(6).toString("hex")}`;
    const r = await deliver(
      { channel: "sms", recipient: "+447700900123", purpose: "test.dlr" },
      async () => ({ providerMessageId }),
      { config: config(), store: memoryStore() },
    );
    const status = (s: string, detail?: string) =>
      recordDeliveryStatus({
        channel: "sms",
        providerMessageId,
        status: s,
        detail,
      });
    expect(await status("delivered")).toEqual({ matched: 1, updated: 1 });
    // A late "sent" callback must not undo "delivered".
    expect(await status("sent")).toEqual({ matched: 1, updated: 0 });
    expect(await rowOf(r.id)).toMatchObject({ deliveryStatus: "delivered" });
    expect(
      await recordDeliveryStatus({
        channel: "email",
        providerMessageId,
        status: "bounced",
      }),
    ).toEqual({ matched: 0, updated: 0 });
  });

  it("sms: STOP-style suppression blocks a number in any format; START lifts only that", async () => {
    const number = `+4477009${String(randomBytes(3).readUIntBE(0, 3) % 100000).padStart(5, "0")}`;
    await suppress({ channel: "sms", recipient: number, reason: "sms STOP" });
    const deps = { config: config(), store: memoryStore() };
    const send = spy();
    const spaced = `${number.slice(0, 3)} ${number.slice(3, 7)} ${number.slice(7)}`;
    expect(
      await deliver(
        { channel: "sms", recipient: spaced, purpose: "test.stop" },
        send,
        deps,
      ),
    ).toMatchObject({ status: "blocked", reason: "SUPPRESSED" });
    expect(send).not.toHaveBeenCalled();
    expect(
      await unsuppress({
        channel: "sms",
        recipient: number,
        reasonPrefix: "sms STOP",
      }),
    ).toBe(1);
    expect(
      (
        await deliver(
          { channel: "sms", recipient: number, purpose: "test.stop" },
          send,
          deps,
        )
      ).status,
    ).toBe("sent");
  });
});
