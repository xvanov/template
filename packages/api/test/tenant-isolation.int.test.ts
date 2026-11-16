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
});
