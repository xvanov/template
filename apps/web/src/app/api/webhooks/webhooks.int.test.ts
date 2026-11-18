/**
 * The provider webhooks as Next runs them (the route handlers themselves),
 * against real Postgres, with signatures computed the way each provider
 * documents them. The job queue is mocked: we assert what would be queued.
 */
import { createHmac, randomBytes } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";
import { ensureEmailAddress } from "@repo/inbound"; // @module:inbound
import { findSuppression } from "@repo/outbound";

import { POST as emailEvents } from "./email-events/route";
import { POST as emailInbound } from "./email-inbound/route"; // @module:inbound
import { POST as twilioInbound } from "./twilio/route"; // @module:sms
import { POST as twilioStatus } from "./twilio/status/route"; // @module:sms

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@repo/jobs", () => ({ enqueue }));

const SVIX_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const HMAC_SECRET = "generic-test-secret";
const TWILIO_TOKEN = "twilio-test-token"; // @module:sms
const PUBLIC = "https://app.example.test"; // @module:sms
const DOMAIN = `in-${randomBytes(3).toString("hex")}.example.test`; // @module:inbound

beforeAll(() => {
  Object.assign(process.env, {
    RESEND_WEBHOOK_SECRET: SVIX_SECRET,
    EMAIL_WEBHOOK_SECRET: HMAC_SECRET,
    TWILIO_AUTH_TOKEN: TWILIO_TOKEN, // @module:sms
    TWILIO_WEBHOOK_BASE_URL: PUBLIC, // @module:sms
    INBOUND_EMAIL_DOMAIN: DOMAIN, // @module:inbound
  });
  resetEnvCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => enqueue.mockClear());

const uid = () => randomBytes(6).toString("hex");

/** Svix: base64 HMAC-SHA256 of `${id}.${ts}.${body}`, keyed by the decoded secret. */
function svixRequest(
  body: unknown,
  opts: { ts?: number; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  const id = `msg_${uid()}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? SVIX_SECRET).slice(6), "base64");
  const sig = createHmac("sha256", key)
    .update(`${id}.${ts}.${raw}`)
    .digest("base64");
  return new Request("http://internal:3000/api/webhooks/email-events", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
      "content-type": "application/json",
    },
    body: raw,
  });
}

function hmacRequest(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", HMAC_SECRET)
    .update(`${ts}.${raw}`)
    .digest("hex");
  return new Request(`http://internal:3000${path}`, {
    method: "POST",
    headers: {
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `sha256=${sig}`,
    },
    body: raw,
  });
}

// @module:sms
/** Twilio: base64 HMAC-SHA1 of the PUBLIC url + sorted key/value pairs. */
function twilioRequest(
  path: string,
  params: Record<string, string>,
  token = TWILIO_TOKEN,
) {
  const data =
    PUBLIC +
    path +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const sig = createHmac("sha1", token).update(data).digest("base64");
  // The request URL is the INTERNAL one, as behind a proxy.
  return new Request(`http://10.0.0.5:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": sig,
    },
    body: new URLSearchParams(params).toString(),
  });
}
// @end

describe("/api/webhooks/email-events (Resend, Svix-signed)", () => {
  it("records delivery on our message by Resend's id", async () => {
    const a = await createTenant("wh-dlr");
    const emailId = `re-${uid()}`;
    const row = await db.outboundMessage.create({
      data: {
        organizationId: a.organizationId,
        channel: "email",
        recipient: `c-${uid()}@customer.test`,
        purpose: "test",
        status: "sent",
        providerMessageId: emailId,
      },
    });
    const res = await emailEvents(
      svixRequest({
        type: "email.delivered",
        data: { email_id: emailId, to: [row.recipient] },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "delivered", matched: 1 });
    expect(
      (await db.outboundMessage.findUniqueOrThrow({ where: { id: row.id } }))
        .deliveryStatus,
    ).toBe("delivered");
  });

  it("refuses a wrong secret and a replayed (old) timestamp", async () => {
    const body = {
      type: "email.complained",
      data: { email_id: "x", to: ["v@x.test"] },
    };
    const wrong = `whsec_${randomBytes(24).toString("base64")}`;
    expect(
      (await emailEvents(svixRequest(body, { secret: wrong }))).status,
    ).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 600;
    expect((await emailEvents(svixRequest(body, { ts: old }))).status).toBe(
      401,
    );
    expect(await findSuppression("email", "v@x.test", null)).toBeNull();
  });

  // @module:inbound
  it("email.received for a tenant's address is stored and queued", async () => {
    const a = await createTenant("wh-recv");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const res = await emailEvents(
      svixRequest({
        type: "email.received",
        data: {
          email_id: `re-${uid()}`,
          from: "x@customer.test",
          to: [address],
          subject: "Hi",
        },
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, inbound: "created" });
    expect(enqueue).toHaveBeenCalledWith(
      "inbound.process",
      {
        organizationId: a.organizationId,
        inboundMessageId: expect.any(String),
      },
      { jobId: expect.stringMatching(/^inbound-/) },
    );
  });
  // @end
});

// @module:inbound
describe("/api/webhooks/email-inbound (generic, HMAC-signed)", () => {
  it("stores a signed message for the right tenant, once", async () => {
    const a = await createTenant("wh-gen");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const body = {
      id: `g-${uid()}`,
      from: "x@customer.test",
      to: [address],
      text: "hello",
    };
    const first = await (
      await emailInbound(hmacRequest("/api/webhooks/email-inbound", body))
    ).json();
    const again = await (
      await emailInbound(hmacRequest("/api/webhooks/email-inbound", body))
    ).json();
    expect(first).toMatchObject({ routed: true, duplicate: false });
    expect(again).toMatchObject({
      routed: true,
      duplicate: true,
      id: first.id,
    });
    expect(
      await db.inboundMessage.count({
        where: { organizationId: a.organizationId },
      }),
    ).toBe(1);
  });

  it("refuses an unsigned body", async () => {
    const res = await emailInbound(
      new Request("http://internal:3000/api/webhooks/email-inbound", {
        method: "POST",
        body: JSON.stringify({ id: "x", from: "a@b.test", to: ["c@d.test"] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
// @end

// @module:sms
describe("/api/webhooks/twilio", () => {
  const number = () =>
    `+4477009${String(randomBytes(3).readUIntBE(0, 3) % 100000).padStart(5, "0")}`;

  it("verifies against the PUBLIC url (not the internal one) and applies STOP", async () => {
    const from = number();
    const params = {
      MessageSid: `SM${uid()}`,
      From: from,
      To: "+15550100000",
      Body: "STOP",
    };
    const res = await twilioInbound(
      twilioRequest("/api/webhooks/twilio", params),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await findSuppression("sms", from, null)).toMatchObject({
      reason: "sms STOP",
    });
  });

  it("refuses a forged STOP (wrong token) without touching the suppression list", async () => {
    const from = number();
    const params = {
      MessageSid: `SM${uid()}`,
      From: from,
      To: "+15550100000",
      Body: "STOP",
    };
    const res = await twilioInbound(
      twilioRequest("/api/webhooks/twilio", params, "not-the-token"),
    );
    expect(res.status).toBe(401);
    expect(await findSuppression("sms", from, null)).toBeNull();
  });

  it("status callback: signed → recorded on our message", async () => {
    const sid = `SM${uid()}`;
    const row = await db.outboundMessage.create({
      data: {
        channel: "sms",
        recipient: number(),
        purpose: "test",
        status: "sent",
        providerMessageId: sid,
      },
    });
    const res = await twilioStatus(
      twilioRequest("/api/webhooks/twilio/status", {
        MessageSid: sid,
        MessageStatus: "delivered",
      }),
    );
    expect(await res.json()).toEqual({ ok: true, matched: 1 });
    expect(
      (await db.outboundMessage.findUniqueOrThrow({ where: { id: row.id } }))
        .deliveryStatus,
    ).toBe("delivered");
  });
});
// @end

describe("every webhook: size cap before signature work; throttling only of failed signatures", () => {
  const routes = [
    ["email-events", emailEvents],
    ["email-inbound", emailInbound], // @module:inbound
    ["twilio", twilioInbound], // @module:sms
    ["twilio/status", twilioStatus], // @module:sms
  ] as const;

  it("refuses an oversized chunked body (no Content-Length) with 413", async () => {
    for (const [name, handler] of routes) {
      const huge = new ReadableStream<Uint8Array>({
        start(c) {
          // 16 MB in 1 MB chunks: past every route's cap, inbound email's too.
          for (let i = 0; i < 16; i++) c.enqueue(new Uint8Array(1 << 20));
          c.close();
        },
      });
      const res = await handler(
        new Request(`http://internal:3000/api/webhooks/${name}`, {
          method: "POST",
          body: huge,
          // Node's fetch needs this for a stream body (cast below: whether
          // RequestInit declares it depends on the installed @types).
          duplex: "half",
        } as RequestInit),
      );
      expect(res.status, name).toBe(413);
    }
  });

  it("throttles only FAILED signatures per IP: a flood of forgeries cannot 429 real callbacks", async () => {
    // An attacker sets X-Forwarded-For to whatever IP the provider uses.
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const body = { type: "bounce", email: `t-${uid()}@customer.test` };
    const forged = () =>
      emailEvents(
        new Request("http://internal:3000/api/webhooks/email-events", {
          method: "POST",
          headers: {
            "x-forwarded-for": ip,
            "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
            "x-webhook-signature": "sha256=forged",
          },
          body: JSON.stringify(body),
        }),
      );
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await forged()).status;
    expect(last).toBe(429);

    // The provider's real, signed callback to the SAME webhook from that same
    // IP still goes through.
    const signed = hmacRequest("/api/webhooks/email-events", body);
    signed.headers.set("x-forwarded-for", ip);
    const res = await emailEvents(signed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
