/**
 * Documents and search (packages/rag). The writes are rag's domain functions
 * (transaction + audit); indexing is the `docs.ingest` worker job, enqueued
 * AFTER the transaction commits so the worker never looks for a row that is
 * not there yet. Search and answer work with the AI off (keyword-only /
 * "unknown"), so nothing here needs the LLM to be configured.
 *
 * Text arrives as a string field, not a multipart upload: it is text with a
 * size cap (MAX_DOCUMENT_CHARS), and the browser reads the file itself.
 * Files already in storage are indexed by id (fromMedia); their bytes are
 * read by the worker.
 */
import { z } from "zod";
import { enqueue } from "@repo/jobs";
import {
  answerQuestion,
  createDocument,
  createDocumentFromMedia,
  createDocumentInput,
  documentFromMediaInput,
  removeDocument,
  markQueueFailed,
  removeDocumentInput,
  requestReindex,
  searchDocs,
} from "@repo/rag";

import { createTRPCRouter, orgProcedure, rateLimited } from "../trpc";

type Ctx = { organizationId: string; user: { id: string } };

function actor(ctx: Ctx) {
  return { organizationId: ctx.organizationId, userId: ctx.user.id };
}

/** How long a create waits for Redis before giving up on queueing. */
const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Queue indexing. The document is already committed; if the job cannot be
 * queued (Redis down — BullMQ would otherwise wait for it indefinitely), the
 * document is marked failed with "Re-index to retry" instead of sitting at
 * "pending" forever, and the mutation still succeeds.
 */
async function queueIngest(ctx: Ctx, documentId: string, force = false) {
  const job = { organizationId: ctx.organizationId, documentId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      enqueue("docs.ingest", { ...job, ...(force ? { force } : {}) }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`no answer from the queue in ${ENQUEUE_TIMEOUT_MS}ms`),
            ),
          ENQUEUE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch (err) {
    console.error("[docs] could not queue indexing:", err);
    await markQueueFailed(job);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const searchInput = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(8),
  mode: z.enum(["hybrid", "keyword"]).default("hybrid"),
});

export const docsRouter = createTRPCRouter({
  list: orgProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(50) })
        .default({ limit: 50 }),
    )
    .query(({ ctx, input }) =>
      ctx.db.document.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          title: true,
          source: true,
          contentType: true,
          status: true,
          chunkCount: true,
          embeddedCount: true,
          embeddingModel: true,
          note: true,
          indexedAt: true,
          createdAt: true,
        },
      }),
    ),

  create: orgProcedure
    .use(rateLimited({ limit: 30, windowSeconds: 60 }))
    .input(createDocumentInput)
    .mutation(async ({ ctx, input }) => {
      const doc = await ctx.db.$transaction((tx) =>
        createDocument(tx, actor(ctx), input, (a, o) => ctx.audit(a, o, tx)),
      );
      return { ...doc, queued: await queueIngest(ctx, doc.id) };
    }),

  /** Index a text file already in storage (media). */
  fromMedia: orgProcedure
    .use(rateLimited({ limit: 30, windowSeconds: 60 }))
    .input(documentFromMediaInput)
    .mutation(async ({ ctx, input }) => {
      const doc = await ctx.db.$transaction((tx) =>
        createDocumentFromMedia(tx, actor(ctx), input, (a, o) =>
          ctx.audit(a, o, tx),
        ),
      );
      return { ...doc, queued: await queueIngest(ctx, doc.id) };
    }),

  reindex: orgProcedure
    .use(rateLimited({ limit: 30, windowSeconds: 60 }))
    .input(removeDocumentInput)
    .mutation(async ({ ctx, input }) => {
      const doc = await ctx.db.$transaction((tx) =>
        requestReindex(tx, actor(ctx), input, (a, o) => ctx.audit(a, o, tx)),
      );
      return { ...doc, queued: await queueIngest(ctx, doc.id, true) };
    }),

  remove: orgProcedure
    .input(removeDocumentInput)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        removeDocument(tx, actor(ctx), input, (a, o) => ctx.audit(a, o, tx)),
      ),
    ),

  /** Hybrid search; keyword-only (and says why) when embeddings are unavailable. */
  search: orgProcedure
    .use(rateLimited({ limit: 120, windowSeconds: 60 }))
    .input(searchInput)
    .query(({ ctx, input }) =>
      searchDocs(
        (fn) => ctx.db.$transaction(fn),
        { organizationId: ctx.organizationId, userId: ctx.user.id },
        input,
      ),
    ),

  /**
   * A cited answer from the documents, or `status: "unknown"` with the
   * sources a person should look at. Never an unchecked guess.
   */
  answer: orgProcedure
    .use(rateLimited({ limit: 10, windowSeconds: 60 }))
    .input(z.object({ question: z.string().trim().min(1).max(1000) }))
    .mutation(({ ctx, input }) =>
      answerQuestion(
        (fn) => ctx.db.$transaction(fn),
        { organizationId: ctx.organizationId, userId: ctx.user.id },
        input.question,
      ),
    ),
});
