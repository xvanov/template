import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  memoryStore,
  openSecret,
  openSecretDetailed,
  rateLimit,
  sealSecret,
  verifyBearer,
  verifyHmac,
  type SealingKeys,
} from "./index";

const dev = { production: false };
const prod = { production: true };

describe("constantTimeEqual", () => {
  it("is true only for identical strings, whatever the lengths", () => {
    expect(constantTimeEqual("s3cret", "s3cret")).toBe(true);
    expect(constantTimeEqual("s3cret", "s3cre")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("verifyBearer", () => {
  it("accepts the right secret and refuses anything else", () => {
    expect(verifyBearer("Bearer abc", "abc", prod)).toEqual({ ok: true });
    expect(verifyBearer("Bearer abd", "abc", prod)).toMatchObject({
      status: 401,
    });
    expect(verifyBearer("abc", "abc", prod)).toMatchObject({ status: 401 });
    expect(verifyBearer(null, "abc", prod)).toMatchObject({ status: 401 });
  });

  it("FAILS CLOSED in production when the secret is unset", () => {
    expect(
      verifyBearer("Bearer anything", undefined, {
        ...prod,
        secretName: "CRON_SECRET",
      }),
    ).toEqual({
      ok: false,
      status: 500,
      error: "CRON_SECRET is not configured",
    });
  });

  it("lets an unset secret through outside production, as a dev convenience", () => {
    expect(verifyBearer(null, undefined, dev)).toEqual({ ok: true });
  });
});

describe("verifyHmac", () => {
  const secret = "whsec_test";
  const body = '{"event":"paid"}';
  const sig = (s: string) =>
    createHmac("sha256", secret).update(s).digest("hex");

  it("accepts a correct signature over the raw body, with a prefix", () => {
    expect(
      verifyHmac({
        payload: body,
        signature: `sha256=${sig(body)}`,
        prefix: "sha256=",
        secret,
        ...prod,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a signature over a different body", () => {
    expect(
      verifyHmac({
        payload: body + " ",
        signature: sig(body),
        secret,
        ...prod,
      }),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a replayed (stale) timestamp and accepts a fresh one", () => {
    const now = () => 1_700_000_000_000;
    const fresh = "1700000000";
    const stale = "1699999000";
    const opts = { payload: body, secret, toleranceSeconds: 300, now, ...prod };
    expect(
      verifyHmac({
        ...opts,
        timestamp: fresh,
        signature: sig(`${fresh}.${body}`),
      }),
    ).toEqual({ ok: true });
    expect(
      verifyHmac({
        ...opts,
        timestamp: stale,
        signature: sig(`${stale}.${body}`),
      }),
    ).toMatchObject({ status: 401 });
  });

  it("fails closed in production without a secret", () => {
    expect(
      verifyHmac({ payload: body, signature: "x", secret: undefined, ...prod }),
    ).toMatchObject({
      status: 500,
    });
  });
});

describe("rateLimit", () => {
  it("allows up to the limit, then refuses until the window rolls over", async () => {
    let t = 0;
    const store = memoryStore(() => t);
    const hit = () =>
      rateLimit({ key: "k", limit: 2, windowSeconds: 60, store });
    expect((await hit()).allowed).toBe(true);
    expect((await hit()).allowed).toBe(true);
    const third = await hit();
    expect(third).toMatchObject({ allowed: false, count: 3, limit: 2 });
    expect(third.resetSeconds).toBe(60);
    t = 61_000;
    expect(await hit()).toMatchObject({ allowed: true, count: 1 });
  });

  it("keeps separate keys separate", async () => {
    const store = memoryStore();
    await rateLimit({ key: "a", limit: 1, windowSeconds: 60, store });
    expect(
      (await rateLimit({ key: "b", limit: 1, windowSeconds: 60, store }))
        .allowed,
    ).toBe(true);
  });
});

describe("sealSecret / openSecret", () => {
  const key = () => randomBytes(32);
  const keys: SealingKeys = { current: key(), old: [] };

  it("round-trips, in the v1 wire format, with a fresh IV every time", () => {
    const a = sealSecret("refresh-token", { keys });
    const b = sealSecret("refresh-token", { keys });
    expect(a).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toBe(b);
    expect(openSecret(a, { keys })).toBe("refresh-token");
  });

  it("refuses a tampered ciphertext", () => {
    const sealed = sealSecret("token", { keys });
    const [v, iv, tag, data] = sealed.split(":");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      openSecret([v, iv, tag, flipped.toString("base64")].join(":"), { keys }),
    ).toThrow(/no configured key/);
  });

  it("refuses a truncated auth tag (Node would otherwise accept 4 bytes)", () => {
    const sealed = sealSecret("token", { keys });
    const [v, iv, tag, data] = sealed.split(":");
    const short = Buffer.from(tag!, "base64").subarray(0, 4).toString("base64");
    expect(() => openSecret([v, iv, short, data].join(":"), { keys })).toThrow(
      /bad iv or tag length/,
    );
  });

  it("opens values sealed under a retired key, and says they need resealing", () => {
    const oldKey = key();
    const sealed = sealSecret("token", { keys: { current: oldKey, old: [] } });
    const rotated: SealingKeys = { current: key(), old: [oldKey] };
    expect(openSecretDetailed(sealed, { keys: rotated })).toEqual({
      plaintext: "token",
      needsReseal: true,
    });
    expect(
      openSecretDetailed(sealSecret("token", { keys: rotated }), {
        keys: rotated,
      }).needsReseal,
    ).toBe(false);
  });

  it("binds a value to its aad: it will not open in another row", () => {
    const sealed = sealSecret("token", { keys, aad: "account:1" });
    expect(openSecret(sealed, { keys, aad: "account:1" })).toBe("token");
    expect(() => openSecret(sealed, { keys, aad: "account:2" })).toThrow();
  });

  it("rejects something that was never sealed", () => {
    expect(() => openSecret("plaintext-token", { keys })).toThrow(
      /not a sealed value/,
    );
  });
});
