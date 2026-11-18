/**
 * The inbox router: a tenant sees, opens and handles only its own inbound
 * messages (the docs/guide.md org-isolation pattern), and never receives the
 * stored HTML.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";

import { callerFor } from "./caller";

const DOMAIN = `in-${randomBytes(3).toString("hex")}.example.test`;

beforeAll(() => {
  process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
  resetEnvCache();
});
afterAll(() => {
  delete process.env.INBOUND_EMAIL_DOMAIN;
  resetEnvCache();
});

async function inbound(organizationId: string) {
  return db.inboundMessage.create({
    data: {
      organizationId,
      channel: "email",
      provider: "generic",
      providerMessageId: `t-${randomBytes(6).toString("hex")}`,
      fromAddress: "jane@customer.test",
      toAddress: `x@${DOMAIN}`,
      subject: "Hello",
      text: "Plain words",
      snippet: "Plain words",
      html: "<script>alert(1)</script>",
      status: "processed",
    },
    select: { id: true },
  });
}

describe("inbox", () => {
  it("another tenant can neither list, open nor handle a message", async () => {
    const a = await createTenant("inbox-a");
    const b = await createTenant("inbox-b");
    const msg = await inbound(a.organizationId);

    expect((await callerFor(a).inbox.list()).map((m) => m.id)).toEqual([
      msg.id,
    ]);
    expect(await callerFor(b).inbox.list({ show: "all", limit: 50 })).toEqual(
      [],
    );
    await expect(callerFor(b).inbox.get({ id: msg.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      callerFor(b).inbox.setHandled({ id: msg.id, handled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await db.inboundMessage.findUniqueOrThrow({ where: { id: msg.id } }))
        .handledAt,
    ).toBeNull();
  });

  it("opening returns text, never the HTML; handling moves it out of 'open' and is audited", async () => {
    const a = await createTenant("inbox-h");
    const msg = await inbound(a.organizationId);
    const got = await callerFor(a).inbox.get({ id: msg.id });
    expect(got).toMatchObject({ text: "Plain words", hasHtml: true });
    expect(JSON.stringify(got)).not.toContain("<script>");

    await callerFor(a).inbox.setHandled({ id: msg.id, handled: true });
    expect(await callerFor(a).inbox.list()).toEqual([]);
    expect(
      (await callerFor(a).inbox.list({ show: "all", limit: 50 }))[0],
    ).toMatchObject({ id: msg.id, handledAt: expect.any(Date) });
    expect(
      await db.auditEvent.findFirst({
        where: { organizationId: a.organizationId, action: "inbound.handle" },
      }),
    ).toMatchObject({ targetId: msg.id });
  });

  it("creates the tenant's inbound address once, on its own domain", async () => {
    const a = await createTenant("inbox-addr");
    expect(await callerFor(a).inbox.addresses()).toMatchObject({
      emailEnabled: true,
      email: null,
    });
    const { address } = await callerFor(a).inbox.createEmailAddress();
    expect(address.endsWith(`@${DOMAIN}`)).toBe(true);
    expect((await callerFor(a).inbox.createEmailAddress()).address).toBe(
      address,
    );
    expect((await callerFor(a).inbox.addresses()).email).toBe(address);
  });
});
