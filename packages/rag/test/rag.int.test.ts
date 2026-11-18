/**
 * Ingest and search against real Postgres + pgvector, in the throwaway test
 * schema. Embeddings come from the deterministic hashing fake: no network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@repo/db";
import { createTenant, type TestTenant } from "@repo/db/testing";
import { resetEnvCache } from "@repo/env";
import { buildKey, storage } from "@repo/storage";

import { createDocument, createDocumentFromMedia } from "../src/documents";
import { hashEmbedding } from "../src/fake-embed";
import { ingestDocument, type EmbedTexts } from "../src/ingest";
import {
  markIngestFailed,
  STALE_INGEST_MS,
  sweepStaleIngests,
} from "../src/maintenance";
import { searchDocs, type EmbedQuery } from "../src/search";
import { chunkViews, keywordSearch, vectorSearch } from "../src/store";

process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "rag-int-"));
resetEnvCache();

const DIMS = 1536;
const MODEL = "fake/hash";
const calls: string[][] = [];
const embedTexts: EmbedTexts = async (texts) => {
  calls.push(texts);
  return { vectors: texts.map((t) => hashEmbedding(t, DIMS)), model: MODEL };
};
const embedQuery: EmbedQuery = async (q) => ({
  vector: hashEmbedding(q, DIMS),
});
const withEmbeddings = { embedTexts, embeddingModel: () => MODEL };
const noEmbeddings = { embeddingModel: () => null };
const noop = async () => {};
const inTx = <T>(fn: (tx: never) => Promise<T>) =>
  db.$transaction((tx) => fn(tx as never));

const GUIDE = `# Running locally

Start Postgres and Redis with make up, then make dev.

## Ports

The web app listens on port 3200; Postgres is on 5442 and Redis on 6389.

# Backups

Backups run nightly with scripts/backup.sh and are kept for fourteen days.
Restore with scripts/restore.sh.
`;

async function addDoc(t: TestTenant, title: string, content: string) {
  return db.$transaction((tx) =>
    createDocument(
      tx,
      { organizationId: t.organizationId, userId: t.userId },
      { title, content, contentType: "text/markdown" },
      noop,
    ),
  );
}

const who = (t: TestTenant) => ({ organizationId: t.organizationId });

describe("ingest", () => {
  let a: TestTenant;
  beforeAll(async () => {
    a = await createTenant("rag-ingest");
  });

  it("chunks, embeds and stores; re-ingesting unchanged content is a no-op", async () => {
    const doc = await addDoc(a, "Dev guide", GUIDE);
    calls.length = 0;
    const r = await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      withEmbeddings,
    );
    expect(r).toMatchObject({ status: "indexed", chunks: 3, embedded: 3 });
    const row = await db.document.findFirstOrThrow({ where: { id: doc.id } });
    expect(row).toMatchObject({
      status: "ready",
      chunkCount: 3,
      embeddedCount: 3,
      embeddingModel: MODEL,
      note: null,
    });
    expect(calls.flat()).toHaveLength(3);

    calls.length = 0;
    const again = await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      withEmbeddings,
    );
    expect(again.status).toBe("unchanged");
    expect(calls).toHaveLength(0);
  });

  it("an edit re-embeds only the chunks that changed, and replaces the rest in place", async () => {
    const doc = await addDoc(a, "Edit me", GUIDE);
    await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      withEmbeddings,
    );
    const edited = GUIDE.replace("fourteen days", "thirty days");
    await db.document.updateMany({
      where: { id: doc.id, organizationId: a.organizationId },
      data: { content: edited, contentHash: "changed" },
    });
    calls.length = 0;
    const r = await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      withEmbeddings,
    );
    expect(r).toMatchObject({ status: "indexed", chunks: 3, newlyEmbedded: 1 });
    expect(calls.flat()).toEqual([expect.stringContaining("thirty days")]);
    const chunks = await db.documentChunk.findMany({
      where: { documentId: doc.id },
      select: { ord: true },
      orderBy: { ord: "asc" },
    });
    expect(chunks.map((c) => c.ord)).toEqual([0, 1, 2]);
  });

  it("with embeddings off, indexes keyword-only and says so; turning them on fills them in", async () => {
    const doc = await addDoc(a, "Later", GUIDE);
    const off = await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      noEmbeddings,
    );
    expect(off).toMatchObject({ status: "indexed", embedded: 0 });
    expect(off.note).toMatch(/embeddings are off/);

    const on = await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      withEmbeddings,
    );
    expect(on).toMatchObject({ status: "indexed", embedded: 3, note: null });
  });

  it("an embedding failure degrades to keyword-only instead of failing", async () => {
    const doc = await addDoc(a, "Flaky", GUIDE);
    const r = await ingestDocument(
      { organizationId: a.organizationId, documentId: doc.id },
      {
        embeddingModel: () => MODEL,
        embedTexts: async () => {
          throw new Error("provider down");
        },
      },
    );
    expect(r).toMatchObject({ status: "indexed", embedded: 0 });
    expect(r.note).toMatch(/provider failed.*Re-index/);
    const { hits } = await searchDocs(inTx, who(a), {
      query: "flaky backups",
      mode: "keyword",
    });
    expect(hits.some((h) => h.documentId === doc.id)).toBe(true);
  });

  it("indexes a text file from storage, and refuses one that is not UTF-8", async () => {
    const put = async (name: string, bytes: Uint8Array) => {
      const key = buildKey(a.organizationId, name);
      await storage().put(key, bytes, "text/plain");
      return db.mediaAsset.create({
        data: {
          organizationId: a.organizationId,
          uploadedById: a.userId,
          key,
          filename: name,
          contentType: "text/plain",
          sizeBytes: bytes.byteLength,
        },
      });
    };
    const actor = { organizationId: a.organizationId, userId: a.userId };
    const good = await put(
      "notes.txt",
      new TextEncoder().encode("Quarterly zebra census notes."),
    );
    const doc = await db.$transaction((tx) =>
      createDocumentFromMedia(tx, actor, { mediaAssetId: good.id }, noop),
    );
    // Asking again returns the same document.
    const same = await db.$transaction((tx) =>
      createDocumentFromMedia(tx, actor, { mediaAssetId: good.id }, noop),
    );
    expect(same.id).toBe(doc.id);
    expect(
      await ingestDocument(
        { organizationId: a.organizationId, documentId: doc.id },
        noEmbeddings,
      ),
    ).toMatchObject({ status: "indexed", chunks: 1 });
    const { hits } = await searchDocs(inTx, who(a), {
      query: "zebra",
      mode: "keyword",
    });
    expect(hits.map((h) => h.title)).toEqual(["notes.txt"]);

    const bad = await put("bin.txt", new Uint8Array([0xff, 0xfe, 0x00, 0xc3]));
    const badDoc = await db.$transaction((tx) =>
      createDocumentFromMedia(tx, actor, { mediaAssetId: bad.id }, noop),
    );
    expect(
      await ingestDocument(
        { organizationId: a.organizationId, documentId: badDoc.id },
        noEmbeddings,
      ),
    ).toMatchObject({ status: "failed", note: "The file is not UTF-8 text." });
  });
});

describe("ingest edge cases", () => {
  let a: TestTenant;
  beforeAll(async () => {
    a = await createTenant("rag-edge");
  });
  const job = (id: string) => ({
    organizationId: a.organizationId,
    documentId: id,
  });

  it("a model returning the wrong vector size degrades to keyword-only", async () => {
    const doc = await addDoc(a, "Dims", GUIDE);
    const r = await ingestDocument(job(doc.id), {
      embeddingModel: () => MODEL,
      embedTexts: async (texts) => ({
        vectors: texts.map(() => [1, 0, 0]),
        model: MODEL,
      }),
    });
    expect(r).toMatchObject({ status: "indexed", embedded: 0 });
    expect(r.note).toMatch(/3-dimension/);
    const s = await searchDocs(
      inTx,
      who(a),
      { query: "dims ports" },
      {
        embedQuery: async () => ({ vector: [1, 0, 0] }),
      },
    );
    expect(s.mode).toBe("keyword");
    expect(s.keywordOnly).toMatch(/3 dimensions/);
    expect(s.hits.length).toBeGreaterThan(0);
  });

  it("a run that read the text before an edit does not overwrite the newer chunks", async () => {
    const doc = await addDoc(a, "Race", "# One\n\nfirst version");
    const r = await ingestDocument(job(doc.id), {
      embeddingModel: () => MODEL,
      // The edit lands while this run is embedding.
      embedTexts: async (texts) => {
        await db.document.updateMany({
          where: { id: doc.id, organizationId: a.organizationId },
          data: { content: "# One\n\nsecond version" },
        });
        return embedTexts(texts, who(a));
      },
    });
    expect(r.status).toBe("superseded");
    expect(
      await db.documentChunk.count({ where: { documentId: doc.id } }),
    ).toBe(0);
    expect(await ingestDocument(job(doc.id), withEmbeddings)).toMatchObject({
      status: "indexed",
    });
    const [chunk] = await db.documentChunk.findMany({
      where: { documentId: doc.id },
    });
    expect(chunk!.content).toBe("second version");
  });

  it("a stored file over the size cap fails with a note", async () => {
    const big = new TextEncoder().encode("word ".repeat(100_001));
    const key = buildKey(a.organizationId, "big.txt");
    await storage().put(key, big, "text/plain");
    const asset = await db.mediaAsset.create({
      data: {
        organizationId: a.organizationId,
        uploadedById: a.userId,
        key,
        filename: "big.txt",
        contentType: "text/plain",
        sizeBytes: big.byteLength,
      },
    });
    const doc = await db.$transaction((tx) =>
      createDocumentFromMedia(
        tx,
        { organizationId: a.organizationId, userId: a.userId },
        { mediaAssetId: asset.id },
        noop,
      ),
    );
    const r = await ingestDocument(job(doc.id), noEmbeddings);
    expect(r).toMatchObject({
      status: "failed",
      note: expect.stringMatching(/too large/),
    });
  });

  it("nothing stays 'indexing': final job failure and the stale sweep mark it failed", async () => {
    const d1 = await addDoc(a, "Lost", "text");
    await markIngestFailed(job(d1.id), new Error("database went away\nstack"));
    expect(
      await db.document.findFirstOrThrow({ where: { id: d1.id } }),
    ).toMatchObject({
      status: "failed",
      note: "Indexing failed: database went away. Re-index to retry.",
    });

    const d2 = await addDoc(a, "Stale", "text");
    expect(await sweepStaleIngests(new Date())).toBe(0); // fresh: left alone
    expect(
      await sweepStaleIngests(new Date(Date.now() + STALE_INGEST_MS + 60_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await db.document.findFirstOrThrow({ where: { id: d2.id } }),
    ).toMatchObject({
      status: "failed",
      note: expect.stringMatching(/never finished/),
    });
  });
});

describe("search", () => {
  let a: TestTenant;
  let b: TestTenant;
  beforeAll(async () => {
    a = await createTenant("rag-search-a");
    b = await createTenant("rag-search-b");
    for (const [title, body] of [
      ["Dev guide", GUIDE],
      [
        "Billing",
        "# Invoices\n\nInvoices are issued on the first of the month in USD.",
      ],
      [
        "Security",
        "# Secrets\n\nRotate the encryption key yearly; old keys stay readable.",
      ],
    ] as const) {
      const doc = await addDoc(a, title, body);
      await ingestDocument(
        { organizationId: a.organizationId, documentId: doc.id },
        withEmbeddings,
      );
    }
  });

  it("hybrid: both legs run, results are fused and highlighted", async () => {
    const r = await searchDocs(
      inTx,
      who(a),
      { query: "which port does the web app use" },
      { embedQuery },
    );
    expect(r.mode).toBe("hybrid");
    expect(r.keywordOnly).toBeUndefined();
    const top = r.hits[0]!;
    expect(top.heading).toBe("Dev guide › Running locally › Ports");
    expect(top.matchedBy).toEqual(["keyword", "meaning"]);
    expect(top.snippetParts.some((p) => p.hit && /port/i.test(p.text))).toBe(
      true,
    );
    expect(top.snippet).not.toMatch(/[]/);
  });

  it("keyword-only when embeddings are unavailable, with the reason", async () => {
    const r = await searchDocs(
      inTx,
      who(a),
      { query: "invoices currency" },
      { embedQuery: async () => ({ unavailable: "embeddings are off" }) },
    );
    expect(r).toMatchObject({
      mode: "keyword",
      keywordOnly: "embeddings are off",
    });
    expect(r.hits[0]!.title).toBe("Billing");
  });

  it("heading words find the chunk under them (weight A)", async () => {
    const r = await searchDocs(inTx, who(a), {
      query: "secrets",
      mode: "keyword",
    });
    expect(r.hits[0]!.title).toBe("Security");
  });

  it("odd input never errors", async () => {
    for (const q of ["!!!", "a & b | c:*", "'", "the of and", "\u0000"]) {
      await expect(
        searchDocs(inTx, who(a), { query: q }, { embedQuery }),
      ).resolves.toBeDefined();
    }
  });

  it("tenant isolation: B finds nothing of A's on any path, even with A's chunk ids", async () => {
    const r = await searchDocs(
      inTx,
      who(b),
      { query: "port backups invoices" },
      { embedQuery },
    );
    expect(r.hits).toEqual([]);
    expect(await keywordSearch(db, b.organizationId, "port", 50)).toEqual([]);
    const vec = await db.$transaction((tx) =>
      vectorSearch(tx, b.organizationId, hashEmbedding("port", DIMS), 50),
    );
    expect(vec).toEqual([]);
    const aIds = (await keywordSearch(db, a.organizationId, "port", 50)).map(
      (h) => h.id,
    );
    expect(aIds.length).toBeGreaterThan(0);
    expect(await chunkViews(db, b.organizationId, aIds, "port")).toEqual([]);
    // Ingest names the tenant too: B cannot index A's document.
    const aDoc = await db.document.findFirstOrThrow({
      where: { organizationId: a.organizationId },
    });
    expect(
      await ingestDocument(
        { organizationId: b.organizationId, documentId: aDoc.id },
        withEmbeddings,
      ),
    ).toEqual({ status: "gone" });
  });
});
