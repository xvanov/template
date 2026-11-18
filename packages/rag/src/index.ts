/**
 * Retrieval over the tenant's documents: chunk → embed → store (pgvector +
 * Postgres FTS) → hybrid search (RRF) → optional cited answer.
 *
 *   enqueue("docs.ingest", { organizationId, documentId })   // index
 *   searchDocs((fn) => db.$transaction(fn), who, { query })  // search
 *   answerQuestion(inTx, who, question)                      // answer or "unknown"
 *
 * Keyword search works with the AI off; embeddings make it hybrid. See
 * docs/guide.md, "Documents and search".
 */
export {
  chunkText,
  CHUNKER_VERSION,
  documentHash,
  embedInput,
  MAX_CHARS,
  OVERLAP_CHARS,
  SEP,
  sha256,
  type Chunk,
  type ChunkOptions,
} from "./chunk";
export { rrf, RRF_K, type Fused, type Ranked } from "./fuse";
export {
  chunkViews,
  EMBEDDING_DIMENSIONS,
  HIT_END,
  HIT_START,
  keywordSearch,
  looseQuery,
  vectorSearch,
  type Sql,
} from "./store";
export {
  embedQueryWithAi,
  searchDocs,
  snippetParts,
  unavailableReason,
  type EmbedQuery,
  type InTx,
  type SearchHit,
  type SearchInput,
  type SearchResult,
  type SnippetPart,
} from "./search";
export {
  answerQuestion,
  answerSchema,
  buildPrompt,
  factsText,
  normalizeFigures,
  quoteFound,
  SYSTEM as ANSWER_SYSTEM,
  verifyAnswer,
  type AnswerDeps,
  type AnswerResult,
  type Citation,
  type ModelAnswer,
  type UnknownReason,
} from "./answer";
export {
  EMBED_BATCH,
  embedTextsWithAi,
  ingestDocument,
  type EmbedTexts,
  type IngestResult,
} from "./ingest";
export {
  createDocument,
  createDocumentFromMedia,
  createDocumentInput,
  documentFromMediaInput,
  documentId,
  MAX_DOCUMENT_CHARS,
  removeDocument,
  removeDocumentInput,
  requestReindex,
  TEXT_CONTENT_TYPES,
} from "./documents";
export { hashEmbedding } from "./fake-embed";
export {
  markIngestFailed,
  markQueueFailed,
  STALE_INGEST_MS,
  sweepStaleIngests,
} from "./maintenance";
