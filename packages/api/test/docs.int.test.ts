/**
 * Documents through the real router: org isolation on every procedure, audit
 * rows, and search with the AI off (keyword-only — what CI and the smoke gate
 * run). The worker is played inline: enqueue is captured and the job's own
 * function runs, so no Redis is needed.
 */
import { describe, expect, it, vi } from "vitest";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";
import { ingestDocument } from "@repo/rag";

import { callerFor } from "./caller";

// AI off whatever the shell says: no test may reach a real provider.
process.env.LLM_ENABLED = "false";
resetEnvCache();

const queued: { name: string; payload: Record<string, unknown> }[] = [];
let queueDown = false;
vi.mock("@repo/jobs", () => ({
  enqueue: async (name: string, payload: Record<string, unknown>) => {
    if (queueDown) throw new Error("ECONNREFUSED");
    queued.push({ name, payload });
    return "job-1";
  },
}));

/** Run what the router queued, as the worker would. */
async function drain() {
  for (const job of queued.splice(0)) {
    expect(job.name).toBe("docs.ingest");
    await ingestDocument(
      job.payload as { organizationId: string; documentId: string },
    );
  }
}

const GUIDE =
  "# Deploys\n\nRun scripts/deploy.sh; rollback swaps the image back.";

describe("docs", () => {
  it("create → ingest → search, keyword-only with the AI off", async () => {
    const a = await createTenant("docs-flow");
    const doc = await callerFor(a).docs.create({
      title: "Ops",
      content: GUIDE,
    });
    expect(doc).toMatchObject({ status: "pending", queued: true });
    await drain();

    const [row] = await callerFor(a).docs.list();
    expect(row).toMatchObject({
      id: doc.id,
      status: "ready",
      chunkCount: 1,
      embeddedCount: 0,
    });
    expect(row!.note).toMatch(/keyword search only/i);

    const r = await callerFor(a).docs.search({
      query: "how do I roll back a deploy",
    });
    expect(r).toMatchObject({
      mode: "keyword",
      keywordOnly: "embeddings are off",
    });
    expect(r.hits[0]).toMatchObject({
      documentId: doc.id,
      heading: "Ops › Deploys",
    });

    // AI off: the answer is "unknown" with the sources, never a guess.
    const ans = await callerFor(a).docs.answer({
      question: "how do I roll back?",
    });
    expect(ans).toMatchObject({ status: "unknown", reason: "ai_unavailable" });
    expect(ans.status === "unknown" && ans.sources[0]!.documentId).toBe(doc.id);

    const audit = await db.auditEvent.findMany({
      where: { organizationId: a.organizationId, targetId: doc.id },
      select: { action: true },
    });
    expect(audit.map((e) => e.action)).toEqual(["document.create"]);
  });

  it("another tenant can neither see, search, re-index nor delete them", async () => {
    const a = await createTenant("docs-a");
    const b = await createTenant("docs-b");
    const doc = await callerFor(a).docs.create({
      title: "A's plan",
      content: "Secret merger codename bluefin.",
    });
    await drain();

    expect(await callerFor(b).docs.list()).toEqual([]);
    expect(
      (await callerFor(b).docs.search({ query: "bluefin merger" })).hits,
    ).toEqual([]);
    expect(
      await callerFor(b).docs.answer({ question: "bluefin?" }),
    ).toMatchObject({
      status: "unknown",
      reason: "no_sources",
    });
    await expect(
      callerFor(b).docs.reindex({ id: doc.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(b).docs.remove({ id: doc.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(queued).toEqual([]);

    // A still has it, and can delete it (its chunks go with it).
    expect(
      (await callerFor(a).docs.search({ query: "bluefin" })).hits,
    ).toHaveLength(1);
    await callerFor(a).docs.remove({ id: doc.id });
    expect(
      await db.documentChunk.count({ where: { documentId: doc.id } }),
    ).toBe(0);
  });

  it("fromMedia: only this tenant's files, and only text ones", async () => {
    const a = await createTenant("docs-media-a");
    const b = await createTenant("docs-media-b");
    const asset = (contentType: string) =>
      db.mediaAsset.create({
        data: {
          organizationId: a.organizationId,
          uploadedById: a.userId,
          key: `test/${a.organizationId}/${Math.random()}`,
          filename: "f",
          contentType,
          sizeBytes: 1,
        },
      });
    const text = await asset("text/plain");
    const png = await asset("image/png");
    await expect(
      callerFor(b).docs.fromMedia({ mediaAssetId: text.id }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      callerFor(a).docs.fromMedia({ mediaAssetId: png.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const doc = await callerFor(a).docs.fromMedia({ mediaAssetId: text.id });
    expect(doc).toMatchObject({ source: "media", status: "pending" });
    queued.length = 0;
  });

  it("a document whose indexing cannot be queued says so instead of staying pending", async () => {
    const a = await createTenant("docs-queue-down");
    queueDown = true;
    try {
      const doc = await callerFor(a).docs.create({
        title: "T",
        content: "text",
      });
      expect(doc.queued).toBe(false);
    } finally {
      queueDown = false;
    }
    const [row] = await callerFor(a).docs.list();
    expect(row).toMatchObject({
      status: "failed",
      note: expect.stringMatching(/Re-index/),
    });
    // Re-index retries it.
    await callerFor(a).docs.reindex({ id: row!.id });
    await drain();
    expect((await callerFor(a).docs.list())[0]).toMatchObject({
      status: "ready",
    });
  });

  it("rejects empty and oversized documents", async () => {
    const a = await createTenant("docs-limits");
    await expect(
      callerFor(a).docs.create({ title: "x", content: "   " }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      callerFor(a).docs.create({ title: "x", content: "a".repeat(500_001) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
