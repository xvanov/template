import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  memoryStore,
  openSecret,
  openSecretDetailed,
  rateLimit,
  readBodyLimited,
  readBytesLimited,
  sealSecret,
  verifyBearer,
  verifyHmac,
  verifySvix,
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

describe("readBodyLimited", () => {
  const stream = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < chunks; i++)
          c.enqueue(new Uint8Array(size).fill(97));
        c.close();
      },
    });
  const req = (body: ReadableStream<Uint8Array> | string, headers = {}) =>
    new Request("http://x.test/", {
      method: "POST",
      body,
      headers,
      // Node's fetch needs this for a stream body (cast below: whether
      // RequestInit declares it depends on the installed @types).
      duplex: "half",
    } as RequestInit);

  it("reads a body within the cap", async () => {
    expect(await readBodyLimited(req("héllo"), 100)).toEqual({
      ok: true,
      text: "héllo",
    });
  });

  it("refuses by declared length without reading", async () => {
    expect(
      await readBodyLimited(req("x", { "content-length": "999999" }), 100),
    ).toMatchObject({ ok: false, status: 413 });
  });

  it("refuses a chunked body (no length) once it streams past the cap", async () => {
    expect(await readBodyLimited(req(stream(10, 64)), 300)).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(await readBodyLimited(req(stream(4, 64)), 300)).toMatchObject({
      ok: true,
    });
  });

  it("readBytesLimited keeps binary bytes intact, under the same cap", async () => {
    const bin = new Uint8Array([0xff, 0x00, 0xd8, 0x80]);
    const r = await readBytesLimited(
      new Request("http://x.test/", { method: "POST", body: bin }),
      10,
    );
    expect(r.ok && [...r.bytes]).toEqual([0xff, 0x00, 0xd8, 0x80]);
    expect(await readBytesLimited(req(stream(10, 64)), 300)).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});

describe("verifySvix", () => {
  // The worked example from Svix's documentation ("Verifying webhooks
  // manually"), checked against their reference implementation.
  const doc = {
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: "1614265330",
    payload: '{"test": 2432232314}',
    signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    now: () => 1614265330 * 1000,
    production: true,
  };

  it("accepts Svix's documented test vector", () => {
    expect(verifySvix(doc)).toEqual({ ok: true });
  });

  it("accepts any v1 signature in a space-separated list (secret rotation)", () => {
    expect(
      verifySvix({
        ...doc,
        signature: `v1,bm90LXRoaXMtb25l ${doc.signature}`,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a changed body, id, wrong version or wrong secret", () => {
    for (const over of [
      { payload: '{"test": 2432232315}' },
      { id: "msg_other" },
      { signature: doc.signature.replace("v1,", "v2,") },
      { secret: "whsec_" + Buffer.from("x".repeat(24)).toString("base64") },
      { signature: "" },
    ]) {
      expect(verifySvix({ ...doc, ...over })).toMatchObject({ status: 401 });
    }
  });

  it("refuses a timestamp more than 5 minutes off, either way (replay)", () => {
    expect(
      verifySvix({ ...doc, now: () => (1614265330 + 301) * 1000 }),
    ).toMatchObject({ status: 401 });
    expect(
      verifySvix({ ...doc, now: () => (1614265330 - 301) * 1000 }),
    ).toMatchObject({ status: 401 });
    expect(
      verifySvix({ ...doc, now: () => (1614265330 + 299) * 1000 }),
    ).toEqual({ ok: true });
  });

  it("FAILS CLOSED in production without a secret; open in development", () => {
    expect(verifySvix({ ...doc, secret: undefined })).toMatchObject({
      status: 500,
    });
    expect(
      verifySvix({ ...doc, secret: undefined, signature: null, ...dev }),
    ).toEqual({ ok: true });
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
