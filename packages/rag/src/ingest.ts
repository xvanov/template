/**
 * Index one document: text → chunks → embeddings → document_chunk.
 * Runs in the worker (`docs.ingest`, an org-scoped job), never in a request.
 *
 * Idempotent:
 *  - The document's contentHash covers title, text and CHUNKER_VERSION. If the
 *    chunks were built from that hash and every chunk that can be embedded
 *    is, the run is a no-op ("unchanged") — redelivered jobs and double
 *    clicks cost nothing.
 *  - Otherwise the chunks are rebuilt and REPLACED in one transaction (delete
 *    + insert), so a search never sees half of the old and half of the new.
 *  - A chunk whose heading + text did not change keeps its embedding
 *    (matched by chunk contentHash): editing one paragraph re-embeds one or
 *    two chunks, not the document.
 *
 * Embeddings are best-effort. With AI off, over the daily cap, or the
 * provider failing, the chunks are stored without them and the document is
 * `ready` but keyword-only, with the reason in `note`. Re-indexing later
 * (or the next ingest after embeddings are turned on) fills them in.
 */
import { embed, embeddingModelId, LlmConfigError } from "@repo/ai";
import { db } from "@repo/db";
import { storage } from "@repo/storage";

import { chunkText, documentHash, embedInput, type Chunk } from "./chunk";
import { MAX_DOCUMENT_CHARS } from "./documents";
import { unavailableReason } from "./search";
import {
  EMBEDDING_DIMENSIONS,
  embeddingsByHash,
  replaceChunks,
  toVector,
} from "./store";

/** Texts per embedding request. */
export const EMBED_BATCH = 64;

export type EmbedTexts = (
  texts: string[],
  who: { organizationId: string },
) => Promise<{ vectors: number[][]; model: string }>;

export const embedTextsWithAi: EmbedTexts = async (texts, who) => {
  const r = await embed({
    texts,
    dimensions: EMBEDDING_DIMENSIONS,
    purpose: "docs.ingest",
    // Indexing is deferrable: it stops at the cap (and degrades to keyword).
    priority: "discretionary",
    organizationId: who.organizationId,
  });
  return { vectors: r.embeddings, model: r.model };
};

export interface IngestResult {
  status: "indexed" | "unchanged" | "gone" | "failed" | "superseded";
  chunks?: number;
  embedded?: number;
  /** Chunks embedded by THIS run (the rest reused or none). */
  newlyEmbedded?: number;
  note?: string | null;
}

/** Bytes of a stored file → text, or a reason it is not text. */
function decodeText(bytes: Uint8Array): string | { error: string } {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^﻿/, "");
  } catch {
    return { error: "The file is not UTF-8 text." };
  }
}

export async function ingestDocument(
  job: { organizationId: string; documentId: string; force?: boolean },
  deps: {
    embedTexts?: EmbedTexts;
    /** `provider/model` embeddings would come from now, or null (off). */
    embeddingModel?: () => string | null;
  } = {},
): Promise<IngestResult> {
  const { organizationId, documentId } = job;
  const where = { id: documentId, organizationId };
  const doc = await db.document.findFirst({
    where,
    select: {
      title: true,
      source: true,
      content: true,
      contentType: true,
      indexedHash: true,
      chunkCount: true,
      embeddedCount: true,
      embeddingModel: true,
      mediaAsset: { select: { key: true, organizationId: true } },
    },
  });
  if (!doc) return { status: "gone" };

  const fail = async (note: string): Promise<IngestResult> => {
    await db.document.updateMany({ where, data: { status: "failed", note } });
    return { status: "failed", note };
  };

  // A storage file is read here, in the worker, not in the request.
  let content = doc.content;
  if (doc.source === "media") {
    const asset = doc.mediaAsset;
    if (!asset || asset.organizationId !== organizationId) {
      return fail("The source file was deleted.");
    }
    const text = decodeText(await storage().get(asset.key));
    if (typeof text !== "string") return fail(text.error);
    content = text;
  }
  if (!content.trim()) return fail("The document is empty.");
  // Typed-in documents are capped by the API; a stored file only here.
  if (content.length > MAX_DOCUMENT_CHARS) {
    return fail(
      `The file is too large to search (${content.length.toLocaleString("en-US")} characters; ${MAX_DOCUMENT_CHARS.toLocaleString("en-US")} max).`,
    );
  }

  const hash = documentHash(doc.title, content);
  const currentModel = (deps.embeddingModel ?? embeddingModelId)();
  const canEmbed = currentModel !== null;
  // Vectors from another model live in another space: never mix them.
  const sameModel = doc.embeddingModel === currentModel;
  const complete =
    !canEmbed || (sameModel && doc.embeddedCount >= doc.chunkCount);
  if (!job.force && doc.indexedHash === hash && complete) {
    await db.document.updateMany({
      where: { ...where, status: { in: ["pending", "indexing"] } },
      data: { status: "ready" },
    });
    return { status: "unchanged", chunks: doc.chunkCount };
  }

  await db.document.updateMany({ where, data: { status: "indexing" } });

  const chunks = chunkText(doc.title, content, {
    markdown: doc.contentType !== "text/csv",
  });
  const reuse =
    canEmbed && sameModel
      ? await embeddingsByHash(db, organizationId, documentId)
      : new Map<string, string>();
  const vectors = new Map<string, string>();
  for (const c of chunks) {
    const v = reuse.get(c.contentHash);
    if (v) vectors.set(c.contentHash, v);
  }

  let note: string | null = null;
  let model: string | null = null;
  let newlyEmbedded = 0;
  const todo: Chunk[] = chunks.filter((c) => !vectors.has(c.contentHash));
  if (todo.length > 0 && !canEmbed) {
    note = "Keyword search only: embeddings are off.";
  } else {
    for (let i = 0; i < todo.length; i += EMBED_BATCH) {
      const batch = todo.slice(i, i + EMBED_BATCH);
      try {
        const r = await (deps.embedTexts ?? embedTextsWithAi)(
          batch.map(embedInput),
          { organizationId },
        );
        const wrong = r.vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
        if (wrong || r.vectors.length !== batch.length) {
          throw new LlmConfigError(
            `${r.model} returned ${wrong?.length ?? "?"}-dimension embeddings, the index takes ${EMBEDDING_DIMENSIONS}`,
          );
        }
        model = r.model;
        batch.forEach((c, j) =>
          vectors.set(c.contentHash, toVector(r.vectors[j]!)),
        );
        newlyEmbedded += batch.length;
      } catch (err) {
        const reason = unavailableReason(err);
        if (!reason) console.warn("[rag] embedding failed:", err);
        note = `Partly keyword-only: ${reason ?? "the embedding provider failed"}. Re-index to retry.`;
        break;
      }
    }
  }

  const embedded = chunks.filter((c) => vectors.has(c.contentHash)).length;
  const written = await db.$transaction(async (tx) => {
    // Two ingests of one document (a re-index clicked while the first runs)
    // take turns here, so one replace never interleaves with another.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`docs.ingest:${documentId}`}, 0))`;
    // And a run that read the text BEFORE an edit must not overwrite the
    // chunks of a run that read it after: only the current text is written.
    const now = await tx.document.findFirst({
      where,
      select: { title: true, content: true, source: true },
    });
    if (!now) return false;
    if (
      now.source !== "media" &&
      documentHash(now.title, now.content) !== hash
    ) {
      return false;
    }
    await replaceChunks(
      tx,
      organizationId,
      documentId,
      chunks.map((c) => ({
        ord: c.ord,
        heading: c.heading,
        content: c.content,
        contentHash: c.contentHash,
        embedding: vectors.get(c.contentHash) ?? null,
      })),
    );
    await tx.document.updateMany({
      where,
      data: {
        status: "ready",
        // A media document's text is kept: search snippets and a re-index
        // must not depend on the file still being in storage.
        ...(doc.source === "media" ? { content, contentHash: hash } : {}),
        indexedHash: hash,
        chunkCount: chunks.length,
        embeddedCount: embedded,
        ...(model ? { embeddingModel: model } : {}),
        ...(embedded === 0 ? { embeddingModel: null } : {}),
        note,
        indexedAt: new Date(),
      },
    });
    return true;
  });
  // The text changed while this run worked: the run queued by that change
  // writes the chunks.
  if (!written) return { status: "superseded" };
  return {
    status: "indexed",
    chunks: chunks.length,
    embedded,
    newlyEmbedded,
    note,
  };
}
