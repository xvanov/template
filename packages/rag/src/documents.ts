/**
 * The Document domain: input rules and writes, called by the tRPC docs
 * router (and by anything else that adds documents). Same shape as
 * @repo/domain's items: transaction, actor from the caller's context, audit
 * bound to the transaction, `deleteMany` with the org in the `where`, and one
 * NotFoundError for "absent" and "another tenant's".
 *
 * A write here only records the document as `pending`. Chunking and
 * embedding are slow and can fail, so the caller enqueues `docs.ingest`
 * after the transaction commits (CLAUDE.md rule 5).
 */
import type { Prisma } from "@repo/db";
import {
  DomainRuleError,
  NotFoundError,
  type Actor,
  type DomainAudit,
} from "@repo/domain";
import { z } from "zod";

import { documentHash } from "./chunk";

type Tx = Prisma.TransactionClient;

/** ~100 pages of text. Bigger belongs in storage + a fromMedia ingest. */
export const MAX_DOCUMENT_CHARS = 500_000;

/** Storage content types whose bytes are UTF-8 text worth indexing. */
export const TEXT_CONTENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export const documentId = z.string().min(1).max(64);

export const createDocumentInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  content: z
    .string()
    .max(MAX_DOCUMENT_CHARS, "Document too large (500,000 characters max).")
    .refine((s) => s.trim().length > 0, "The document is empty."),
  contentType: z.enum(["text/markdown", "text/plain"]).default("text/markdown"),
});
export const documentFromMediaInput = z.object({ mediaAssetId: documentId });
export const removeDocumentInput = z.object({ id: documentId });

const NOT_FOUND = "Document not found.";

const summary = {
  id: true,
  title: true,
  source: true,
  status: true,
} as const;

export async function createDocument(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof createDocumentInput>,
  audit: DomainAudit,
) {
  const doc = await tx.document.create({
    data: {
      organizationId: actor.organizationId,
      title: input.title,
      source: "upload",
      contentType: input.contentType,
      content: input.content,
      contentHash: documentHash(input.title, input.content),
      createdById: actor.userId,
    },
    select: summary,
  });
  await audit("document.create", {
    targetId: doc.id,
    metadata: { title: doc.title, source: "upload" },
  });
  return doc;
}

/**
 * Index a text-like file already in storage. Idempotent per file: asking
 * twice returns the existing document (the caller re-ingests it).
 * The bytes are read by the ingest job, not here.
 */
export async function createDocumentFromMedia(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof documentFromMediaInput>,
  audit: DomainAudit,
) {
  const asset = await tx.mediaAsset.findFirst({
    where: { id: input.mediaAssetId, organizationId: actor.organizationId },
    select: { id: true, filename: true, contentType: true },
  });
  if (!asset) throw new NotFoundError("File not found.");
  if (!TEXT_CONTENT_TYPES.has(asset.contentType)) {
    throw new DomainRuleError(
      `Only text files can be searched (this one is ${asset.contentType}).`,
    );
  }
  const existing = await tx.document.findFirst({
    where: { organizationId: actor.organizationId, mediaAssetId: asset.id },
    select: summary,
  });
  if (existing) return existing;
  const doc = await tx.document.create({
    data: {
      organizationId: actor.organizationId,
      title: asset.filename.slice(0, 200),
      source: "media",
      mediaAssetId: asset.id,
      contentType: asset.contentType,
      content: "",
      contentHash: "",
      createdById: actor.userId,
    },
    select: summary,
  });
  await audit("document.create", {
    targetId: doc.id,
    metadata: { title: doc.title, source: "media", mediaAssetId: asset.id },
  });
  return doc;
}

export async function removeDocument(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof removeDocumentInput>,
  audit: DomainAudit,
) {
  // Chunks go with it (FK cascade), embeddings included.
  const { count } = await tx.document.deleteMany({
    where: { id: input.id, organizationId: actor.organizationId },
  });
  if (count === 0) throw new NotFoundError(NOT_FOUND);
  await audit("document.delete", { targetId: input.id });
  return { id: input.id };
}

/** Mark for re-indexing (the caller enqueues the job). */
export async function requestReindex(
  tx: Tx,
  actor: Actor,
  input: z.infer<typeof removeDocumentInput>,
  audit: DomainAudit,
) {
  const { count } = await tx.document.updateMany({
    where: { id: input.id, organizationId: actor.organizationId },
    data: { status: "pending" },
  });
  if (count === 0) throw new NotFoundError(NOT_FOUND);
  await audit("document.reindex", { targetId: input.id });
  return { id: input.id };
}
