/**
 * desktop.feed: what the desktop shell notifies about. A tenant sees only its
 * own events (the CLAUDE.md org-isolation pattern), the first poll replays
 * nothing, and the cursor moves forward.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";

import { callerFor } from "./caller";

async function seed(t: TestTenant) {
  const msg = await db.inboundMessage.create({
    data: {
      organizationId: t.organizationId,
      channel: "email",
      provider: "generic",
      providerMessageId: `d-${randomBytes(6).toString("hex")}`,
      fromAddress: "jane@customer.test",
      toAddress: "in@example.test",
      subject: "Quote please",
    },
    select: { id: true },
  });
  const proposal = await db.agentProposal.create({
    data: {
      organizationId: t.organizationId,
      source: "user",
      proposedById: t.userId,
      tool: "items_create",
      input: {},
      summary: "Create item “Desk”",
    },
    select: { id: true },
  });
  const run = await db.agentRun.create({
    data: {
      organizationId: t.organizationId,
      createdById: t.userId,
      goal: "Tidy the items",
      status: "completed",
      finishedAt: new Date(),
    },
    select: { id: true },
  });
  return { msg, proposal, run };
}

describe("desktop.feed", () => {
  it("the first poll replays nothing and returns a cursor", async () => {
    const a = await createTenant("desk-first");
    await seed(a);
    const first = await callerFor(a).desktop.feed();
    expect(first.events).toEqual([]);
    expect(Date.parse(first.cursor)).not.toBeNaN();
  });

  it("returns this tenant's events since the cursor, and none of another's", async () => {
    const a = await createTenant("desk-a");
    const b = await createTenant("desk-b");
    const { cursor: ca } = await callerFor(a).desktop.feed();
    const { cursor: cb } = await callerFor(b).desktop.feed();
    const { msg, proposal, run } = await seed(a);

    const got = await callerFor(a).desktop.feed({ since: ca });
    expect(got.events.map((e) => e.key).sort()).toEqual(
      [
        `inbound:${msg.id}`,
        `proposal:${proposal.id}`,
        `agent_run:${run.id}:completed`,
      ].sort(),
    );
    expect(got.events.find((e) => e.kind === "inbound")).toMatchObject({
      title: "New email",
      body: "jane@customer.test: Quote please",
    });
    expect(Date.parse(got.cursor)).toBeGreaterThanOrEqual(Date.parse(ca));

    expect((await callerFor(b).desktop.feed({ since: cb })).events).toEqual([]);
  });

  it("a teammate's finished run is not news; a decided proposal is not either", async () => {
    const a = await createTenant("desk-mates");
    const { cursor } = await callerFor(a).desktop.feed();
    await db.agentRun.create({
      data: {
        organizationId: a.organizationId,
        createdById: null,
        goal: "someone else's",
        status: "failed",
        finishedAt: new Date(),
      },
    });
    await db.agentProposal.create({
      data: {
        organizationId: a.organizationId,
        tool: "items_create",
        input: {},
        summary: "already decided",
        status: "rejected",
      },
    });
    expect((await callerFor(a).desktop.feed({ since: cursor })).events).toEqual(
      [],
    );
  });

  it("rejects a cursor that is not a date-time", async () => {
    const a = await createTenant("desk-bad");
    await expect(
      callerFor(a).desktop.feed({ since: "yesterday" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
