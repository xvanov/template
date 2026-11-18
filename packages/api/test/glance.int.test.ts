/**
 * Glance links (src/glance.ts, routers/glance.ts): a link shows ONLY its own
 * organization's snapshot, is managed only by its creator, is stored hashed,
 * and stops working when revoked or when the creator leaves the org.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";

import { authenticateGlanceLink, glanceSnapshot } from "../src/glance";
import { callerFor } from "./caller";

async function seed(t: TestTenant, label: string) {
  await db.agentProposal.create({
    data: {
      organizationId: t.organizationId,
      source: "user",
      proposedById: t.userId,
      tool: "items_create",
      input: {},
      summary: `Create item ${label}`,
    },
  });
  await db.inboundMessage.create({
    data: {
      organizationId: t.organizationId,
      channel: "email",
      provider: "generic",
      providerMessageId: `g-${randomBytes(6).toString("hex")}`,
      fromAddress: `${label}@customer.test`,
      toAddress: "in@example.test",
      subject: `Hello from ${label}`,
    },
  });
}

describe("glance links", () => {
  it("a link reads its own organization's snapshot and nobody else's", async () => {
    const a = await createTenant("glance-a");
    const b = await createTenant("glance-b");
    await seed(a, "alpha");
    await seed(b, "bravo");

    const link = await callerFor(a).glance.createLink({
      name: "My glasses",
      showDetails: true,
    });
    expect(link.secret).toMatch(/^gl_[A-Za-z0-9_-]{43}$/);

    const principal = await authenticateGlanceLink(db, link.secret);
    expect(principal).toMatchObject({
      organizationId: a.organizationId,
      userId: a.userId,
      showDetails: true,
    });
    const snap = await glanceSnapshot(db, principal!.organizationId);
    expect(snap.approvals.count).toBe(1);
    expect(snap.approvals.rows[0]!.title).toBe("Create item alpha");
    expect(snap.inbox.unhandled).toBe(1);
    expect(snap.inbox.rows[0]).toMatchObject({
      title: "alpha@customer.test",
      detail: "Hello from alpha",
    });
    expect(JSON.stringify(snap)).not.toContain("bravo");

    // The signed-in view is the same data, also scoped.
    const bSnap = await callerFor(b).glance.snapshot();
    expect(JSON.stringify(bSnap)).not.toContain("alpha");
  });

  it("B cannot see or revoke A's links, and only the hash is stored", async () => {
    const a = await createTenant("glance-iso-a");
    const b = await createTenant("glance-iso-b");
    const link = await callerFor(a).glance.createLink({ name: "Display" });

    expect(await callerFor(b).glance.links()).toEqual([]);
    await expect(
      callerFor(b).glance.revokeLink({ id: link.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const row = await db.glanceLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(row.hash).not.toContain(link.secret);
    expect(JSON.stringify(row)).not.toContain(link.secret);
    expect(await callerFor(a).glance.links()).toEqual([
      expect.objectContaining({
        id: link.id,
        name: "Display",
        revokedAt: null,
      }),
    ]);
    const audit = await db.auditEvent.findMany({
      where: { organizationId: a.organizationId, targetId: link.id },
      select: { action: true },
    });
    expect(audit.map((e) => e.action)).toEqual(["glance_link.create"]);
  });

  it("stops working when revoked, when the creator leaves, or when malformed", async () => {
    const a = await createTenant("glance-stop");
    const revoked = await callerFor(a).glance.createLink({ name: "old" });
    await callerFor(a).glance.revokeLink({ id: revoked.id });
    expect(await authenticateGlanceLink(db, revoked.secret)).toBeNull();
    await expect(
      callerFor(a).glance.revokeLink({ id: revoked.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const live = await callerFor(a).glance.createLink({ name: "live" });
    expect(await authenticateGlanceLink(db, live.secret)).not.toBeNull();
    await db.member.deleteMany({
      where: { organizationId: a.organizationId, userId: a.userId },
    });
    expect(await authenticateGlanceLink(db, live.secret)).toBeNull();

    expect(await authenticateGlanceLink(db, "gl_short")).toBeNull();
    expect(await authenticateGlanceLink(db, `tk_${"x".repeat(43)}`)).toBeNull();
  });

  it("defaults to counts-only and 30 days; an expired link is refused", async () => {
    const a = await createTenant("glance-expiry");
    await seed(a, "charlie");
    const link = await callerFor(a).glance.createLink({ name: "default" });
    const row = await db.glanceLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(row.showDetails).toBe(false);
    const days =
      (row.expiresAt!.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    const principal = await authenticateGlanceLink(db, link.secret);
    expect(principal?.showDetails).toBe(false);
    const counts = await glanceSnapshot(db, a.organizationId, {
      details: false,
    });
    expect(counts.approvals).toEqual({ count: 1, rows: [] });
    expect(JSON.stringify(counts)).not.toContain("charlie");

    await db.glanceLink.updateMany({
      where: { id: link.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await authenticateGlanceLink(db, link.secret)).toBeNull();

    const forever = await callerFor(a).glance.createLink({
      name: "forever",
      expiresInDays: null,
    });
    expect(
      (await db.glanceLink.findUniqueOrThrow({ where: { id: forever.id } }))
        .expiresAt,
    ).toBeNull();
  });
});
