/**
 * notifyOperator and runDigest against REAL Postgres and the real outbound
 * guard: the rows are the product, so they are asserted on. ntfy is a fake
 * fetch (no network); the guard's counters are in memory under NODE_ENV=test.
 * Safe mode is STRICT with an EMPTY allowlist throughout, which is the point:
 * the operator's own topic/address still gets through, nothing else would.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { resetEnvCache, serverEnvKeys } from "@repo/env";

import {
  notifyOperator,
  retryCapHeld,
  runDigest,
  type OperatorNotification,
} from "./index";

const KEYS = serverEnvKeys.filter((k) =>
  /^(NTFY_|NOTIFY_|OPERATOR_|OUTBOUND_|SMTP_|APP_TIMEZONE|APP_URL)/.test(k),
);
const hex = () => randomBytes(4).toString("hex");

function setEnv(vars: Record<string, string> = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(
    process.env,
    {
      OUTBOUND_SAFE_MODE: "true",
      OUTBOUND_SAFE_RECIPIENTS: "",
      NTFY_URL: "http://127.0.0.1:9",
      // A fresh topic per test: the per-recipient volume cap is per topic.
      NTFY_TOPIC: `ops-${hex()}`,
    },
    vars,
  );
  resetEnvCache();
}

function fakeNtfy() {
  const sent: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `m${sent.length}` });
  });
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch };
}

const note = (
  over: Partial<OperatorNotification> = {},
): OperatorNotification => ({
  title: `Alert ${hex()}`,
  body: "details",
  priority: "high",
  ...over,
});
const rowOf = (id: string | null) =>
  db.notification.findUniqueOrThrow({ where: { id: id! } });

beforeEach(() => {
  setEnv();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});
afterAll(() => {
  for (const k of KEYS) delete process.env[k];
  resetEnvCache();
});

describe("notifyOperator", () => {
  it("pushes to the operator's topic through the guard, in strict safe mode, and records both rows", async () => {
    const ntfy = fakeNtfy();
    const r = await notifyOperator(
      note({ tags: ["warning"], organizationId: "org_ctx" }),
      { fetch: ntfy.fetch },
    );
    expect(r).toMatchObject({ status: "sent", channel: "push" });
    expect(ntfy.sent).toHaveLength(1);
    expect(ntfy.sent[0]).toMatchObject({
      topic: process.env.NTFY_TOPIC,
      priority: 4,
      tags: ["warning"],
    });
    const row = await rowOf(r.id);
    expect(row).toMatchObject({
      status: "sent",
      channel: "push",
      organizationId: "org_ctx",
    });
    // The send is operator mail: never attributed to (or visible to) a tenant.
    expect(
      await db.outboundMessage.findUniqueOrThrow({
        where: { id: row.outboundMessageId! },
      }),
    ).toMatchObject({
      channel: "push",
      status: "sent",
      purpose: "operator.notify",
      organizationId: null,
      providerMessageId: "m1",
    });
  });

  it("dedupe: the same key within the window is recorded, not re-sent; after it, sent again", async () => {
    const ntfy = fakeNtfy();
    const dedupeKey = `k-${hex()}`;
    const now = new Date("2030-06-01T12:00:00Z");
    const first = await notifyOperator(note({ dedupeKey }), {
      fetch: ntfy.fetch,
      now,
    });
    const again = await notifyOperator(note({ dedupeKey }), {
      fetch: ntfy.fetch,
      now: new Date(now.getTime() + 59 * 60_000),
    });
    expect(again.status).toBe("deduped");
    expect((await rowOf(again.id)).error).toBe(`duplicate of ${first.id}`);
    const later = await notifyOperator(note({ dedupeKey }), {
      fetch: ntfy.fetch,
      now: new Date(now.getTime() + 61 * 60_000),
    });
    expect(later.status).toBe("sent");
    expect(ntfy.sent).toHaveLength(2);
  });

  it("dedupe holds under concurrency: five at once, one sent", async () => {
    const ntfy = fakeNtfy();
    const dedupeKey = `race-${hex()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        notifyOperator(note({ dedupeKey }), { fetch: ntfy.fetch }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      "deduped",
      "deduped",
      "deduped",
      "deduped",
      "sent",
    ]);
    expect(ntfy.sent).toHaveLength(1);
  });

  it("a per-call window: once per org per day", async () => {
    const ntfy = fakeNtfy();
    const dedupeKey = `ai-cap:org_${hex()}:2030-07-01`;
    const at = (h: number) => new Date(Date.UTC(2030, 6, 1, h));
    const send = (h: number) =>
      notifyOperator(note({ dedupeKey, dedupeWindowMinutes: 24 * 60 }), {
        fetch: ntfy.fetch,
        now: at(h),
      });
    expect((await send(1)).status).toBe("sent");
    expect((await send(9)).status).toBe("deduped");
    expect((await send(23)).status).toBe("deduped");
  });

  it("no topic: falls back to email to OPERATOR_EMAIL, through the guard, in strict mode", async () => {
    setEnv({ NTFY_TOPIC: "", OPERATOR_EMAIL: `ops-${hex()}@ops.example` });
    const r = await notifyOperator(note({ organizationId: "org_ctx" }));
    expect(r).toMatchObject({ status: "sent", channel: "email" });
    const row = await rowOf(r.id);
    expect(
      await db.outboundMessage.findUniqueOrThrow({
        where: { id: row.outboundMessageId! },
      }),
    ).toMatchObject({
      channel: "email",
      recipient: process.env.OPERATOR_EMAIL,
      purpose: "operator.notify",
      organizationId: null,
      detail: "logged to console (SMTP_HOST unset)",
    });
  });

  it("neither configured: the console, and the row says so", async () => {
    setEnv({ NTFY_TOPIC: "" });
    const r = await notifyOperator(note());
    expect(r).toMatchObject({ status: "logged", channel: "console" });
    expect((await rowOf(r.id)).status).toBe("logged");
  });

  it("never throws: a dead ntfy is recorded as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await notifyOperator(note(), {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(r.status).toBe("failed");
    expect((await rowOf(r.id)).error).toBe("ECONNREFUSED");
  });

  it("a FAILED alert does not silence its repeat: the operator gets the next one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dedupeKey = `down-${hex()}`;
    const first = await notifyOperator(note({ dedupeKey }), {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(first.status).toBe("failed");
    const ntfy = fakeNtfy();
    const again = await notifyOperator(note({ dedupeKey }), {
      fetch: ntfy.fetch,
    });
    expect(again.status).toBe("sent");
    // ...and once one got through, the next IS a duplicate.
    expect(
      (await notifyOperator(note({ dedupeKey }), { fetch: ntfy.fetch })).status,
    ).toBe("deduped");
  });

  it("a pending row mutes its key only while in flight: claimed < 2 min ago yes, older no", async () => {
    const now = new Date("2030-09-01T12:00:00Z");
    const pendingRow = async (dedupeKey: string, claimedMsAgo: number) =>
      db.notification.create({
        data: {
          priority: "normal",
          title: "x",
          body: "",
          channel: "push",
          status: "pending",
          dedupeKey,
          createdAt: new Date(now.getTime() - 60 * 60_000),
          claimedAt: new Date(now.getTime() - claimedMsAgo),
        },
      });
    const ntfy = fakeNtfy();
    const live = `live-${hex()}`;
    await pendingRow(live, 30_000);
    expect(
      (
        await notifyOperator(note({ dedupeKey: live }), {
          fetch: ntfy.fetch,
          now,
        })
      ).status,
    ).toBe("deduped");
    const dead = `dead-${hex()}`;
    await pendingRow(dead, 5 * 60_000);
    expect(
      (
        await notifyOperator(note({ dedupeKey: dead }), {
          fetch: ntfy.fetch,
          now,
        })
      ).status,
    ).toBe("sent");
  });

  it("a high/urgent row whose sender crashed mid-send is retried, not stranded", async () => {
    const now = new Date("2045-01-01T12:00:00Z");
    const row = (claimedMsAgo: number) =>
      db.notification.create({
        data: {
          priority: "urgent",
          title: `crashed ${hex()}`,
          body: "",
          channel: "push",
          status: "pending",
          createdAt: new Date(now.getTime() - 10 * 60_000),
          claimedAt: new Date(now.getTime() - claimedMsAgo),
        },
        select: { id: true },
      });
    const abandoned = await row(5 * 60_000);
    const inFlight = await row(30_000);
    const ntfy = fakeNtfy();
    await retryCapHeld({ fetch: ntfy.fetch, now });
    expect(await rowOf(abandoned.id)).toMatchObject({
      status: "sent",
      claimedAt: now,
    });
    expect(await rowOf(inFlight.id)).toMatchObject({ status: "pending" });
    // Claimed again just now: a second tick leaves it alone.
    await retryCapHeld({ fetch: ntfy.fetch, now });
    expect(
      ntfy.sent.filter((m) => String(m.title).includes("crashed")),
    ).toHaveLength(1);
  });

  it("urgent does not stop at the per-recipient cap: the operator's topic is exempt", async () => {
    setEnv({ OUTBOUND_CAP_RECIPIENT_PER_HOUR: "3" });
    const ntfy = fakeNtfy();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await notifyOperator(note({ priority: "urgent" }), {
            fetch: ntfy.fetch,
          })
        ).status,
      );
    }
    expect(statuses).toEqual(Array(6).fill("sent"));
  });

  it("an urgent alert the (operator pool) cap blocks is held, and the next tick sends it", async () => {
    setEnv({ OUTBOUND_CAP_GLOBAL_PER_HOUR: "1" });
    const ntfy = fakeNtfy();
    const r = await notifyOperator(note({ priority: "urgent" }), {
      fetch: ntfy.fetch,
    });
    expect(r.status).toBe("held");
    expect((await rowOf(r.id)).error).toMatch(/^VOLUME/);
    expect(ntfy.sent).toHaveLength(0);

    process.env.OUTBOUND_CAP_GLOBAL_PER_HOUR = "100000";
    resetEnvCache();
    expect(await retryCapHeld({ fetch: ntfy.fetch })).toBe(1);
    expect(await rowOf(r.id)).toMatchObject({ status: "sent", error: null });
    expect(ntfy.sent).toHaveLength(1);
    // Nothing left to retry.
    expect(await retryCapHeld({ fetch: ntfy.fetch })).toBe(0);
  });

  it("prefixes what it sends with the APP_URL host; stores the bare title", async () => {
    setEnv({ APP_URL: "https://staging.example.com" });
    const ntfy = fakeNtfy();
    const r = await notifyOperator(note({ title: "Disk almost full" }), {
      fetch: ntfy.fetch,
    });
    expect(ntfy.sent[0]).toMatchObject({
      title: "[staging.example.com] Disk almost full",
    });
    expect((await rowOf(r.id)).title).toBe("Disk almost full");
  });

  it("the guard's kill switch still applies to operator pushes", async () => {
    setEnv({ OUTBOUND_FROZEN: "true" });
    const ntfy = fakeNtfy();
    const r = await notifyOperator(note(), { fetch: ntfy.fetch });
    expect(r.status).toBe("blocked");
    expect((await rowOf(r.id)).error).toMatch(/^FROZEN/);
    expect(ntfy.sent).toHaveLength(0);
  });
});

describe("runDigest", () => {
  it("sends held notifications once per slot, then marks them digested", async () => {
    setEnv({ NOTIFY_DIGEST_TIMES: "09:00,17:00" });
    const ntfy = fakeNtfy();
    const low = await notifyOperator(
      note({ priority: "low", title: "New sign-up (example.test)" }),
      { fetch: ntfy.fetch },
    );
    expect(low.status).toBe("held");
    expect(ntfy.sent).toHaveLength(0);

    const now = new Date("2031-01-01T10:00:00Z");
    const d = await runDigest({ fetch: ntfy.fetch, now });
    expect(d).toMatchObject({ slot: "2031-01-01 09:00", status: "sent" });
    expect(d!.count).toBeGreaterThanOrEqual(1);
    expect(ntfy.sent).toHaveLength(1);
    expect(ntfy.sent[0]).toMatchObject({ priority: 3 });
    expect(String(ntfy.sent[0]!.message)).toContain(
      "New sign-up (example.test)",
    );
    expect(await rowOf(low.id)).toMatchObject({
      status: "digested",
      digestId: d!.digestId,
    });

    // Same slot again: nothing. Next slot with nothing held: recorded, silent.
    expect(await runDigest({ fetch: ntfy.fetch, now })).toBeNull();
    const empty = await runDigest({
      fetch: ntfy.fetch,
      now: new Date("2031-01-01T17:05:00Z"),
    });
    expect(empty).toMatchObject({ slot: "2031-01-01 17:00", count: 0 });
    expect(ntfy.sent).toHaveLength(1);
  });

  it("a digest that is NOT delivered gives its items back for the next slot", async () => {
    setEnv({ NOTIFY_DIGEST_TIMES: "09:00,17:00" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const low = await notifyOperator(note({ priority: "low" }));
    const failed = await runDigest({
      now: new Date("2032-01-01T09:30:00Z"),
      fetch: (async () => {
        throw new Error("ntfy down");
      }) as unknown as typeof fetch,
    });
    expect(failed).toMatchObject({ status: "failed" });
    expect(await rowOf(failed!.digestId)).toMatchObject({ status: "failed" });
    expect(await rowOf(low.id)).toMatchObject({
      status: "held",
      digestId: null,
    });

    const ntfy = fakeNtfy();
    const ok = await runDigest({
      now: new Date("2032-01-01T17:30:00Z"),
      fetch: ntfy.fetch,
    });
    expect(ok).toMatchObject({ status: "sent" });
    expect(await rowOf(low.id)).toMatchObject({
      status: "digested",
      digestId: ok!.digestId,
    });
  });

  it("a digest the cap blocks is marked failed, never held (it would swallow its items)", async () => {
    setEnv({ NOTIFY_DIGEST_TIMES: "09:00", OUTBOUND_CAP_GLOBAL_PER_HOUR: "1" });
    const low = await notifyOperator(note({ priority: "low" }));
    const ntfy = fakeNtfy();
    const d = await runDigest({
      now: new Date("2033-01-01T09:30:00Z"),
      fetch: ntfy.fetch,
    });
    expect(d).toMatchObject({ status: "failed" });
    const row = await rowOf(d!.digestId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^VOLUME/);
    expect(await rowOf(low.id)).toMatchObject({ status: "held" });
    expect(ntfy.sent).toHaveLength(0);
  });
});
