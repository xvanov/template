/**
 * The Expo push transport without a network: a fake fetch stands in for
 * https://exp.host. Batching, tickets, receipts, and the lock-screen text.
 * (sendMobilePush through the real guard and Postgres: send.int.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@repo/env";

import { pushText, useFakeExpoFetch } from "./index";
import {
  DeviceNotRegisteredError,
  enqueueMessage,
  fetchReceipts,
  MAX_SEND_BATCH,
  transmit,
  type ExpoMessage,
  type ExpoTicket,
} from "./transport";

const tok = (n: number | string) => `ExponentPushToken[device-${n}-aaaa]`;
const msg = (n: number): ExpoMessage => ({
  to: tok(n),
  title: "t",
  body: "b",
});

type Call = { url: string; body: unknown; headers: Record<string, string> };

/** A fake Expo: records each request; answers via `reply`. */
function fakeExpo(
  reply: (url: string, body: unknown) => { status?: number; json: unknown },
) {
  const calls: Call[] = [];
  useFakeExpoFetch(async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({
      url,
      body,
      headers: init.headers as Record<string, string>,
    });
    const r = reply(url, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  });
  return calls;
}

/** Tickets "ok" for every message in a send. */
const okTickets = (_url: string, body: unknown) => ({
  json: {
    data: (body as ExpoMessage[]).map((m) => ({
      status: "ok",
      id: `t:${m.to}`,
    })),
  },
});

afterEach(() => {
  useFakeExpoFetch(undefined);
  delete process.env.EXPO_ACCESS_TOKEN;
  resetEnvCache();
});

describe("batching", () => {
  it("messages queued together go in ONE request, each caller gets its own ticket", async () => {
    const calls = fakeExpo(okTickets);
    const tickets = await Promise.all(
      [1, 2, 3].map((n) => enqueueMessage(msg(n))),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://exp.host/--/api/v2/push/send");
    expect((calls[0]!.body as ExpoMessage[]).map((m) => m.to)).toEqual([
      tok(1),
      tok(2),
      tok(3),
    ]);
    expect(tickets).toEqual(
      [1, 2, 3].map((n) => ({ status: "ok", id: `t:${tok(n)}` })),
    );
  });

  it("splits at Expo's 100-per-request limit", async () => {
    const calls = fakeExpo(okTickets);
    const n = MAX_SEND_BATCH + 30;
    const tickets = await Promise.all(
      Array.from({ length: n }, (_, i) => enqueueMessage(msg(i))),
    );
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 30]);
    expect(tickets[n - 1]).toEqual({ status: "ok", id: `t:${tok(n - 1)}` });
  });

  it("a failed request fails every message in it (the guard records each as failed)", async () => {
    fakeExpo(() => ({
      status: 429,
      json: { errors: [{ code: "TOO_MANY_REQUESTS", message: "slow down" }] },
    }));
    const results = await Promise.allSettled(
      [1, 2].map((n) => enqueueMessage(msg(n))),
    );
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect(String((r as PromiseRejectedResult).reason)).toContain(
        "Expo push 429 TOO_MANY_REQUESTS: slow down",
      );
    }
  });

  it("refuses a reply whose ticket count does not match", async () => {
    fakeExpo(() => ({ json: { data: [{ status: "ok", id: "only-one" }] } }));
    const results = await Promise.allSettled(
      [1, 2].map((n) => enqueueMessage(msg(n))),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("sends EXPO_ACCESS_TOKEN as a bearer token only when set", async () => {
    const calls = fakeExpo(okTickets);
    await enqueueMessage(msg(1));
    expect(calls[0]!.headers.authorization).toBeUndefined();
    process.env.EXPO_ACCESS_TOKEN = "secret-token";
    resetEnvCache();
    await enqueueMessage(msg(2));
    expect(calls[1]!.headers.authorization).toBe("Bearer secret-token");
  });
});

describe("transmit (what the guard calls)", () => {
  const send = (ticket: ExpoTicket) => {
    const calls = fakeExpo(() => ({ json: { data: [ticket] } }));
    const p = transmit(
      tok(9),
      { title: "Hi", body: "There", data: { kind: "x" } },
      {
        messageId: "om_1",
      },
    );
    return { p, calls };
  };

  it("returns the ticket id as the provider message id, and tags the message with its row", async () => {
    const { p, calls } = send({ status: "ok", id: "ticket-1" });
    await expect(p).resolves.toEqual({ providerMessageId: "ticket-1" });
    expect((calls[0]!.body as ExpoMessage[])[0]).toMatchObject({
      to: tok(9),
      title: "Hi",
      data: { kind: "x", messageId: "om_1" },
    });
  });

  it("DeviceNotRegistered on the ticket → DeviceNotRegisteredError carrying the token", async () => {
    const { p } = send({
      status: "error",
      message: "not registered",
      details: { error: "DeviceNotRegistered" },
    });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceNotRegisteredError);
    expect((err as DeviceNotRegisteredError).token).toBe(tok(9));
  });

  it("any other ticket error is a plain error (recorded as failed, retried by jobs)", async () => {
    const { p } = send({
      status: "error",
      message: "too big",
      details: { error: "MessageTooBig" },
    });
    await expect(p).rejects.toThrow(
      "Expo push ticket error MessageTooBig: too big",
    );
    await p.catch((e: unknown) =>
      expect(e).not.toBeInstanceOf(DeviceNotRegisteredError),
    );
  });
});

describe("fetchReceipts", () => {
  it("asks in chunks of 1000 ids and merges the answers", async () => {
    const calls = fakeExpo((_url, body) => ({
      json: {
        data: Object.fromEntries(
          (body as { ids: string[] }).ids.map((id) => [id, { status: "ok" }]),
        ),
      },
    }));
    const ids = Array.from({ length: 1500 }, (_, i) => `r${i}`);
    const receipts = await fetchReceipts(ids);
    expect(calls.map((c) => c.url)).toEqual([
      "https://exp.host/--/api/v2/push/getReceipts",
      "https://exp.host/--/api/v2/push/getReceipts",
    ]);
    expect(calls.map((c) => (c.body as { ids: string[] }).ids.length)).toEqual([
      1000, 500,
    ]);
    expect(Object.keys(receipts)).toHaveLength(1500);
  });
});

describe("no network under test", () => {
  it("refuses to call the real Expo service without a fake", async () => {
    vi.useFakeTimers();
    try {
      const p = enqueueMessage(msg(1));
      vi.runAllTimers();
      await expect(p).rejects.toThrow("Refusing to call the Expo push service");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pushText: nothing about who or what on the lock screen", () => {
  it("says only what kind of thing happened", () => {
    expect(pushText({ kind: "item", id: "i1" })).toEqual({
      title: "New item",
      body: "Someone in your workspace added an item.",
      data: { kind: "item", id: "i1" },
    });
    // @module:agent
    expect(pushText({ kind: "proposal", id: "p1" })).toEqual({
      title: "Waiting for your approval",
      body: "An agent proposal needs your review.",
      data: { kind: "proposal", id: "p1" },
    });
    // @end
    // @module:inbound
    expect(
      pushText({ kind: "inbound", id: "m1" }, { channel: "sms" }).title,
    ).toBe("New text message");
    expect(
      pushText({ kind: "inbound", id: "m1" }, { channel: "email" }).title,
    ).toBe("New email");
    // @end
  });
});
