/**
 * Org isolation, proven against real SQL. The pattern for any org-scoped
 * table: tenant A writes, tenant B reads through the real router, and B must
 * see nothing of A's. Copy this when you add a model.
 */
import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { processJob, SKIPPED_ORG_GONE } from "@repo/jobs";

import { callerFor } from "./caller";

describe("tenant isolation", () => {
  it("items: another tenant can neither see nor change them", async () => {
    const a = await createTenant("items-a");
    const b = await createTenant("items-b");

    const item = await callerFor(a).items.create({ title: "A's secret" });

    expect((await callerFor(a).items.list()).map((i) => i.id)).toEqual([
      item.id,
    ]);
    expect(await callerFor(b).items.list()).toEqual([]);
    await expect(
      callerFor(b).items.setDone({ id: item.id, done: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(b).items.remove({ id: item.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("media: another tenant cannot delete it", async () => {
    const a = await createTenant("media-a");
    const b = await createTenant("media-b");
    const asset = await db.mediaAsset.create({
      data: {
        organizationId: a.organizationId,
        uploadedById: a.userId,
        key: `test/${a.organizationId}/pic.png`,
        filename: "pic.png",
        contentType: "image/png",
        sizeBytes: 1,
      },
    });

    await expect(
      callerFor(b).media.remove({ id: asset.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.mediaAsset.count({ where: { id: asset.id } })).toBe(1);

    await callerFor(a).media.remove({ id: asset.id });
    expect(await db.mediaAsset.count({ where: { id: asset.id } })).toBe(0);
  });

  it("job runs: the worker stamps the owner; only that tenant sees the run", async () => {
    const a = await createTenant("jobs-a");
    const b = await createTenant("jobs-b");

    // The worker's real recording path, minus Redis.
    await processJob({
      id: "jr-a",
      name: "items.summarize",
      data: { organizationId: a.organizationId, userId: a.userId },
      attemptsMade: 0,
    });
    const system = await db.jobRun.create({
      data: { jobId: "jr-sys", name: "maintenance.nightly" },
    });

    const seenByA = await callerFor(a).items.recentJobs();
    expect(seenByA.map((r) => [r.name, r.status])).toEqual([
      ["items.summarize", "completed"],
    ]);
    expect(seenByA.map((r) => r.id)).not.toContain(system.id);
    expect(await callerFor(b).items.recentJobs()).toEqual([]);
  });

  it("job runs: a job whose organization was deleted does not run", async () => {
    const gone = await createTenant("jobs-gone");
    await db.organization.delete({ where: { id: gone.organizationId } });

    const result = await processJob({
      id: "jr-gone",
      name: "items.summarize",
      data: { organizationId: gone.organizationId },
      attemptsMade: 0,
    });

    expect(result).toBe(SKIPPED_ORG_GONE);
    const run = await db.jobRun.findFirstOrThrow({
      where: { jobId: "jr-gone", payload: { contains: gone.organizationId } },
    });
    expect(run).toMatchObject({ status: "skipped", organizationId: null });
  });

  it("audit events: written by mutations, readable only by their own tenant", async () => {
    const a = await createTenant("audit-a");
    const b = await createTenant("audit-b");

    const item = await callerFor(a).items.create({ title: "audited" });
    await callerFor(a).items.setDone({ id: item.id, done: true });
    await callerFor(a).items.remove({ id: item.id });

    const trail = await callerFor(a).activity.audit();
    expect(
      trail.map((e) => [e.action, e.targetType, e.targetId, e.actorId]),
    ).toEqual([
      ["item.delete", "item", item.id, a.userId],
      ["item.update", "item", item.id, a.userId],
      ["item.create", "item", item.id, a.userId],
    ]);
    expect(await callerFor(b).activity.audit()).toEqual([]);
    expect(
      await callerFor(b).activity.audit({ limit: 50, targetId: item.id }),
    ).toEqual([]);
  });

  it("audit events: a mutation that fails writes no audit row (same transaction)", async () => {
    const a = await createTenant("audit-tx-a");
    const b = await createTenant("audit-tx-b");
    const item = await callerFor(a).items.create({ title: "A's" });

    await expect(
      callerFor(b).items.remove({ id: item.id }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await db.auditEvent.count({
        where: { organizationId: b.organizationId },
      }),
    ).toBe(0);
  });

  it("outbound log: a tenant sees its own messages, never another's or system mail", async () => {
    const a = await createTenant("ob-a");
    const b = await createTenant("ob-b");
    const base = { channel: "email", purpose: "test", status: "sent" };
    await db.outboundMessage.createMany({
      data: [
        { ...base, organizationId: a.organizationId, recipient: "x@a.test" },
        {
          ...base,
          organizationId: null,
          recipient: "signup@a.test",
          purpose: "auth.verify-email",
        },
      ],
    });

    expect(
      (await callerFor(a).activity.outbound()).map((m) => m.recipient),
    ).toEqual(["x@a.test"]);
    expect(await callerFor(b).activity.outbound()).toEqual([]);
  });

  it("activity is for owners and admins only", async () => {
    const a = await createTenant("act-role");
    await db.member.updateMany({
      where: { organizationId: a.organizationId, userId: a.userId },
      data: { role: "member" },
    });
    await expect(callerFor(a).activity.audit()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("activity accepts a comma-separated role list that includes admin", async () => {
    const a = await createTenant("act-multi");
    await db.member.updateMany({
      where: { organizationId: a.organizationId, userId: a.userId },
      data: { role: "member, admin" },
    });
    await expect(callerFor(a).activity.audit()).resolves.toEqual([]);
  });

  it("a member removed by an admin loses the org, though the session still names it", async () => {
    const a = await createTenant("removed");
    await callerFor(a).items.create({ title: "before removal" });
    await db.member.deleteMany({
      where: { userId: a.userId, organizationId: a.organizationId },
    });
    // callerFor still passes the stale activeOrganizationId.
    await expect(callerFor(a).items.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
