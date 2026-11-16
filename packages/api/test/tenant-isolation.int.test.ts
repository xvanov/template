/**
 * Org isolation, proven against real SQL. The pattern for any org-scoped
 * table: tenant A writes, tenant B reads through the real router, and B must
 * see nothing of A's. Copy this when you add a model.
 */
import { describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { tenantOf } from "@repo/jobs";

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

  it("job runs: a tenant sees its own, never another tenant's or a system job", async () => {
    const a = await createTenant("jobs-a");
    const b = await createTenant("jobs-b");

    // Stamped exactly as the worker stamps them: from the payload.
    const payload = { organizationId: a.organizationId, userId: a.userId };
    const mine = await db.jobRun.create({
      data: {
        jobId: "1",
        name: "items.summarize",
        organizationId: tenantOf(payload),
      },
    });
    const system = await db.jobRun.create({
      data: {
        jobId: "2",
        name: "maintenance.nightly",
        organizationId: tenantOf({}),
      },
    });

    const seenByA = (await callerFor(a).items.recentJobs()).map((r) => r.id);
    expect(seenByA).toEqual([mine.id]);
    expect(seenByA).not.toContain(system.id);
    expect(await callerFor(b).items.recentJobs()).toEqual([]);
  });
});
