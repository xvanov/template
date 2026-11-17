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

import { notifyOperator, runDigest, type OperatorNotification } from "./index";

const KEYS = serverEnvKeys.filter((k) =>
  /^(NTFY_|NOTIFY_|OPERATOR_|OUTBOUND_|SMTP_|APP_TIMEZONE)/.test(k),
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

  it("budget: normal is held once the 24h budget is spent; high still goes", async () => {
    setEnv({ NOTIFY_PUSH_BUDGET: "2" });
    const ntfy = fakeNtfy();
    const now = new Date("2040-01-01T12:00:00Z");
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (
          await notifyOperator(note({ priority: "normal" }), {
            fetch: ntfy.fetch,
            now,
          })
        ).status,
      );
    }
    expect(statuses).toEqual(["sent", "sent", "held"]);
    expect(
      (
        await notifyOperator(note({ priority: "high" }), {
          fetch: ntfy.fetch,
          now,
        })
      ).status,
    ).toBe("sent");
  });

  it("quiet hours hold normal for the digest; urgent bypasses them", async () => {
    setEnv({ NOTIFY_QUIET_HOURS: "22-07" });
    const ntfy = fakeNtfy();
    const now = new Date("2035-01-01T23:00:00Z");
    const normal = await notifyOperator(note({ priority: "normal" }), {
      fetch: ntfy.fetch,
      now,
    });
    expect(normal.status).toBe("held");
    expect((await rowOf(normal.id)).error).toBe("quiet hours");
    const urgent = await notifyOperator(note({ priority: "urgent" }), {
      fetch: ntfy.fetch,
      now,
    });
    expect(urgent.status).toBe("sent");
    expect(ntfy.sent.at(-1)).toMatchObject({ priority: 5 });
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
});
