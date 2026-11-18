/**
 * Inbound messages against real Postgres: routing to the right tenant (and
 * only that tenant), dedupe of provider retries, the worker's processing
 * (attachments into storage, threading), SMS opt-out. Providers are faked;
 * storage is a temp directory. No network.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { useFakeResend, type FakeResend } from "@repo/email";
import { resetEnvCache } from "@repo/env";
import { deliver, findSuppression } from "@repo/outbound";
import { memoryStore } from "@repo/security";
import { storage } from "@repo/storage";

import {
  ensureEmailAddress,
  handleInboundSms,
  handleResendEvent,
  handleSmsStatus,
  intakeGenericEmail,
  processInbound,
  routeEmail,
  type GenericInboundEmail,
} from "../src/index";

const DOMAIN = `in-${randomBytes(3).toString("hex")}.example.test`;

beforeAll(() => {
  process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "inbound-int-"));
  resetEnvCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  delete process.env.INBOUND_EMAIL_DOMAIN;
  useFakeResend(undefined);
  resetEnvCache();
  vi.restoreAllMocks();
});

const uid = () => randomBytes(6).toString("hex");
const number = () =>
  `+4477009${String(randomBytes(3).readUIntBE(0, 3) % 100000).padStart(5, "0")}`;

function mail(over: Partial<GenericInboundEmail> = {}): GenericInboundEmail {
  return {
    id: `gen-${uid()}`,
    from: "Jane Customer <jane@customer.test>",
    to: ["nobody@elsewhere.test"],
    subject: "Question about my order",
    text: "Hello, where is my order?",
    ...over,
  };
}

/** Send through the real guard (safe mode off), as the app would have. */
async function sentEmail(organizationId: string) {
  return deliver(
    {
      channel: "email",
      recipient: `c-${uid()}@customer.test`,
      purpose: "test.thread",
      organizationId,
    },
    async (to, meta) => ({
      providerMessageId: `<obm.${meta.messageId}@app.test>`,
    }),
    {
      config: {
        safeMode: "off",
        safeRecipients: [],
        enabled: { email: true, push: true, sms: true },
        operatorRecipients: {},
        frozen: false,
        caps: {
          recipientPerHour: 100,
          orgPerHour: 100,
          orgPerDay: 100,
          globalPerHour: 1000,
        },
      },
      store: memoryStore(),
    },
  );
}

describe("routing", () => {
  it("concurrent first calls still give a tenant exactly ONE address", async () => {
    const a = await createTenant("in-addr-race");
    const got = await Promise.all(
      Array.from({ length: 5 }, () => ensureEmailAddress(a.organizationId)),
    );
    expect(new Set(got).size).toBe(1);
    expect(
      await db.inboundRoute.count({
        where: { organizationId: a.organizationId },
      }),
    ).toBe(1);
    // ...and inside a transaction, a lost race does not abort it.
    await db.$transaction(async (tx) => {
      expect(await ensureEmailAddress(a.organizationId, tx)).toBe(got[0]);
      await tx.inboundRoute.count();
    });
  });

  it("gives each tenant one random address on the inbound domain, stable across calls", async () => {
    const a = await createTenant("in-addr");
    const first = await ensureEmailAddress(a.organizationId);
    expect(first).toMatch(
      new RegExp(`^in-addr-[a-z0-9-]*-[a-z2-9]{8}@${DOMAIN}$`),
    );
    expect(await ensureEmailAddress(a.organizationId)).toBe(first);
  });

  it("routes by exact address, display-name form and plus tag; nothing else", async () => {
    const a = await createTenant("in-route");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const [local, domain] = address.split("@");
    const want = { organizationId: a.organizationId, address };
    expect(await routeEmail([address.toUpperCase()])).toEqual(want);
    expect(await routeEmail([`Support <${address}>`])).toEqual(want);
    expect(await routeEmail([`${local}+billing@${domain}`])).toEqual(want);
    expect(await routeEmail([`x${address}`])).toBeNull();
    expect(await routeEmail(["a@b.test, " + address])).toBeNull();
  });

  it("a message to tenant A's address is stored for A only, and an unknown address stores nothing", async () => {
    const a = await createTenant("in-iso-a");
    const b = await createTenant("in-iso-b");
    const address = (await ensureEmailAddress(a.organizationId))!;
    await ensureEmailAddress(b.organizationId);

    const r = await intakeGenericEmail(mail({ to: [address] }));
    expect(r).toMatchObject({
      outcome: "created",
      organizationId: a.organizationId,
    });
    expect(
      await db.inboundMessage.count({
        where: { organizationId: b.organizationId },
      }),
    ).toBe(0);

    const lost = mail({ to: [`nobody-${uid()}@${DOMAIN}`] });
    expect(await intakeGenericEmail(lost)).toEqual({ outcome: "unrouted" });
    expect(
      await db.inboundMessage.count({ where: { providerMessageId: lost.id } }),
    ).toBe(0);
  });
});

describe("dedupe and processing", () => {
  it("a provider retry of the same message is a duplicate, not a second row", async () => {
    const a = await createTenant("in-dup");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const m = mail({ to: [address] });
    const first = await intakeGenericEmail(m);
    const again = await intakeGenericEmail(m);
    expect(first.outcome).toBe("created");
    expect(again).toMatchObject({
      outcome: "duplicate",
      id: (first as { id: string }).id,
      needsProcessing: true,
    });
    await processInbound({
      organizationId: a.organizationId,
      inboundMessageId: (first as { id: string }).id,
    });
    expect(await intakeGenericEmail(m)).toMatchObject({
      outcome: "duplicate",
      needsProcessing: false,
    });
  });

  it("stores allowed attachments, skips the rest, derives text from HTML, threads to our message", async () => {
    const a = await createTenant("in-proc");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const ours = await sentEmail(a.organizationId);
    const r = await intakeGenericEmail(
      mail({
        to: [address],
        text: undefined,
        html: "<p>Thanks!<br>See <b>attached</b>.</p><script>alert(1)</script>",
        inReplyTo: `<obm.${ours.id}@app.test>`,
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            content: Buffer.from("%PDF-1.4 test").toString("base64"),
          },
          {
            filename: "../../evil.html",
            contentType: "text/html",
            content: Buffer.from("<script>").toString("base64"),
          },
        ],
      }),
    );
    if (r.outcome === "unrouted") throw new Error("unrouted");
    const result = await processInbound({
      organizationId: a.organizationId,
      inboundMessageId: r.id,
    });
    expect(result).toEqual({
      status: "processed",
      attachments: 1,
      threaded: true,
    });

    const row = await db.inboundMessage.findUniqueOrThrow({
      where: { id: r.id },
    });
    expect(row).toMatchObject({
      status: "processed",
      text: "Thanks!\nSee attached.",
      replyToOutboundId: ours.id,
      raw: null,
    });
    const [pdf, html] = row.attachments as {
      filename: string;
      mediaAssetId: string | null;
      skipped?: string;
    }[];
    expect(html).toMatchObject({
      filename: ".._.._evil.html",
      mediaAssetId: null,
      skipped: "file type not accepted",
    });
    const asset = await db.mediaAsset.findUniqueOrThrow({
      where: { id: pdf!.mediaAssetId! },
    });
    expect(asset).toMatchObject({
      organizationId: a.organizationId,
      uploadedById: null,
      filename: "invoice.pdf",
    });
    expect(Buffer.from(await storage().get(asset.key)).toString()).toBe(
      "%PDF-1.4 test",
    );

    // Re-running the job (a redelivery) changes nothing.
    expect(
      await processInbound({
        organizationId: a.organizationId,
        inboundMessageId: r.id,
      }),
    ).toEqual({ status: "already processed" });
  });

  it("a forged reference to ANOTHER tenant's message does not thread", async () => {
    const a = await createTenant("in-forge-a");
    const b = await createTenant("in-forge-b");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const theirs = await sentEmail(b.organizationId);
    const r = await intakeGenericEmail(
      mail({ to: [address], references: [`<obm.${theirs.id}@app.test>`] }),
    );
    if (r.outcome === "unrouted") throw new Error("unrouted");
    await processInbound({
      organizationId: a.organizationId,
      inboundMessageId: r.id,
    });
    expect(
      (await db.inboundMessage.findUniqueOrThrow({ where: { id: r.id } }))
        .replyToOutboundId,
    ).toBeNull();
  });

  it("Resend: email.received stores metadata; the worker fetches the content", async () => {
    const a = await createTenant("in-resend");
    const address = (await ensureEmailAddress(a.organizationId))!;
    const emailId = `re-${uid()}`;
    const get = vi.fn(async () => ({
      data: {
        id: emailId,
        from: "Bob <bob@customer.test>",
        to: [address],
        received_for: [address],
        subject: "Re: your quote",
        text: "Looks good.",
        html: null,
        headers: { "In-Reply-To": "<x@y>" },
        message_id: "<abc@customer.test>",
        attachments: [],
      },
      error: null,
    }));
    useFakeResend({
      emails: { receiving: { get, attachments: { list: vi.fn() } } },
    } as unknown as FakeResend);

    const outcome = await handleResendEvent({
      type: "email.received",
      data: {
        email_id: emailId,
        from: "Bob <bob@customer.test>",
        to: [address],
        received_for: [address],
        subject: "Re: your quote",
      },
    });
    if (outcome.kind !== "inbound" || outcome.intake.outcome === "unrouted")
      throw new Error(`not stored: ${JSON.stringify(outcome)}`);
    await processInbound({
      organizationId: a.organizationId,
      inboundMessageId: outcome.intake.id,
    });
    expect(get).toHaveBeenCalledWith(emailId);
    expect(
      await db.inboundMessage.findUniqueOrThrow({
        where: { id: outcome.intake.id },
      }),
    ).toMatchObject({
      provider: "resend",
      text: "Looks good.",
      messageIdHeader: "<abc@customer.test>",
      inReplyTo: "<x@y>",
    });
  });

  it("Resend: a permanent bounce marks our message and suppresses the address; a transient one only marks it", async () => {
    const a = await createTenant("in-bounce");
    const ours = await sentEmail(a.organizationId);
    const row = await db.outboundMessage.findUniqueOrThrow({
      where: { id: ours.id },
    });
    const event = (type: string) => ({
      type: "email.bounced",
      data: {
        email_id: row.providerMessageId!,
        to: [row.recipient],
        bounce: { type, subType: "General", message: "mailbox does not exist" },
      },
    });

    await handleResendEvent(event("Transient"));
    expect(await findSuppression("email", row.recipient, null)).toBeNull();

    expect(await handleResendEvent(event("Permanent"))).toMatchObject({
      kind: "delivery",
      status: "bounced",
      matched: 1,
      suppressed: true,
    });
    expect(
      await db.outboundMessage.findUniqueOrThrow({ where: { id: ours.id } }),
    ).toMatchObject({
      deliveryStatus: "bounced",
      deliveryDetail: "Permanent: General: mailbox does not exist",
    });
    expect(await findSuppression("email", row.recipient, null)).toMatchObject({
      organizationId: null,
    });
  });
});

describe("sms", () => {
  /** A text from `from`, as Twilio posts it. */
  const twilioParams = (from: string, body: string, to = "+15550100000") => ({
    MessageSid: `SM${uid()}`,
    From: from,
    To: to,
    Body: body,
    NumMedia: "0",
    AccountSid: "AC_not_stored",
  });

  it("a reply from a number TWO tenants texted goes to neither (and the operator is told)", async () => {
    const a = await createTenant("in-sms-amb-a");
    const b = await createTenant("in-sms-amb-b");
    const bob = number();
    const text = (organizationId: string) =>
      deliver(
        { channel: "sms", recipient: bob, purpose: "test.sms", organizationId },
        async () => ({ providerMessageId: `SM${uid()}` }),
        {
          config: {
            safeMode: "off",
            safeRecipients: [],
            enabled: { email: true, push: true, sms: true },
            operatorRecipients: {},
            frozen: false,
            caps: {
              recipientPerHour: 100,
              orgPerHour: 100,
              orgPerDay: 100,
              globalPerHour: 1000,
            },
          },
          store: memoryStore(),
        },
      );
    await text(a.organizationId); // "Your appointment with Dr A..."
    await text(b.organizationId); // B texts Bob afterwards (or on purpose)
    const shared = `+1555${String(randomBytes(3).readUIntBE(0, 3) % 10_000_000).padStart(7, "0")}`;
    const r = await handleInboundSms(
      twilioParams(bob, "Can we move it to 4?", shared),
    );
    expect(r).toMatchObject({ ok: true, outcome: "unrouted" });
    for (const t of [a, b]) {
      expect(
        await db.inboundMessage.count({
          where: { organizationId: t.organizationId },
        }),
      ).toBe(0);
    }
    expect(
      await db.notification.findFirst({
        where: { dedupeKey: `inbound-sms-ambiguous:${shared}` },
      }),
    ).toMatchObject({ priority: "low" });

    // With its own number (an inbound_route row), the tenant gets its replies.
    await db.inboundRoute.create({
      data: {
        organizationId: a.organizationId,
        channel: "sms",
        address: shared,
      },
    });
    expect(
      await handleInboundSms(twilioParams(bob, "Can we move it to 4?", shared)),
    ).toMatchObject({
      ok: true,
      outcome: "created",
      organizationId: a.organizationId,
    });
  });

  it("routes a reply to the ONE tenant that texted the number; strangers are dropped", async () => {
    const a = await createTenant("in-sms");
    const from = number();
    const sent = await deliver(
      {
        channel: "sms",
        recipient: from,
        purpose: "test.sms",
        organizationId: a.organizationId,
      },
      async () => ({ providerMessageId: `SM${uid()}` }),
      {
        config: {
          safeMode: "off",
          safeRecipients: [],
          enabled: { email: true, push: true, sms: true },
          operatorRecipients: {},
          frozen: false,
          caps: {
            recipientPerHour: 100,
            orgPerHour: 100,
            orgPerDay: 100,
            globalPerHour: 1000,
          },
        },
        store: memoryStore(),
      },
    );
    const r = await handleInboundSms(twilioParams(from, "Yes, 3pm works"));
    expect(r).toMatchObject({
      ok: true,
      keyword: null,
      outcome: "created",
      organizationId: a.organizationId,
    });
    if (!r.ok || r.outcome === "unrouted") throw new Error("not stored");
    await processInbound({
      organizationId: a.organizationId,
      inboundMessageId: r.id,
    });
    const row = await db.inboundMessage.findUniqueOrThrow({
      where: { id: r.id },
    });
    expect(row).toMatchObject({
      channel: "sms",
      fromAddress: from,
      text: "Yes, 3pm works",
      replyToOutboundId: sent.id,
      handledAt: null,
    });
    // The raw params kept for the worker never included the account SID.
    expect(await handleInboundSms(twilioParams(number(), "hi"))).toMatchObject({
      ok: true,
      outcome: "unrouted",
    });
  });

  it("STOP suppresses the number everywhere at once (even unrouted); START lifts it", async () => {
    const from = number();
    const stop = await handleInboundSms(twilioParams(from, " Stop "));
    expect(stop).toMatchObject({
      ok: true,
      keyword: "stop",
      outcome: "unrouted",
    });
    expect(await findSuppression("sms", from, null)).toMatchObject({
      reason: "sms STOP",
      organizationId: null,
    });
    await handleInboundSms(twilioParams(from, "START"));
    expect(await findSuppression("sms", from, null)).toBeNull();
  });

  it("status callbacks update our message; 21610 also suppresses", async () => {
    const a = await createTenant("in-sms-dlr");
    const to = number();
    const sid = `SM${uid()}`;
    const sent = await deliver(
      {
        channel: "sms",
        recipient: to,
        purpose: "test.sms",
        organizationId: a.organizationId,
      },
      async () => ({ providerMessageId: sid }),
      {
        config: {
          safeMode: "off",
          safeRecipients: [],
          enabled: { email: true, push: true, sms: true },
          operatorRecipients: {},
          frozen: false,
          caps: {
            recipientPerHour: 100,
            orgPerHour: 100,
            orgPerDay: 100,
            globalPerHour: 1000,
          },
        },
        store: memoryStore(),
      },
    );
    expect(
      await handleSmsStatus({
        MessageSid: sid,
        MessageStatus: "undelivered",
        ErrorCode: "21610",
      }),
    ).toEqual({ ok: true, matched: 1 });
    expect(
      await db.outboundMessage.findUniqueOrThrow({ where: { id: sent.id } }),
    ).toMatchObject({
      deliveryStatus: "undelivered",
      deliveryDetail: expect.stringMatching(
        /21610: the recipient replied STOP/,
      ),
    });
    expect(await findSuppression("sms", to, a.organizationId)).not.toBeNull();
  });
});
