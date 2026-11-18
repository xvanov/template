/**
 * Resend delivery events against real Postgres: a bounce or complaint lands
 * on the outbound_message we sent, and a permanent one suppresses the address.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { deliver, findSuppression } from "@repo/outbound";
import { memoryStore } from "@repo/security";

import { handleResendDelivery } from "./events";

const uid = () => randomBytes(6).toString("hex");

/** An email the guard sent (safe mode off), with a provider id to match. */
function sentEmail(organizationId: string) {
  return deliver(
    {
      channel: "email",
      recipient: `c-${uid()}@customer.test`,
      purpose: "test.bounce",
      organizationId,
    },
    async (_to, meta) => ({
      providerMessageId: `<obm.${meta.messageId}@app.test>`,
    }),
    {
      config: {
        safeMode: "off",
        safeRecipients: [],
        enabled: {
          email: true,
          push: true,
          sms: true,
          mobile_push: true,
        },
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

describe("Resend delivery events", () => {
  it("a permanent bounce marks our message and suppresses the address; a transient one only marks it", async () => {
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

    await handleResendDelivery(event("Transient"));
    expect(await findSuppression("email", row.recipient, null)).toBeNull();

    expect(await handleResendDelivery(event("Permanent"))).toMatchObject({
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
