/**
 * Every query that touches `document_chunk.embedding` or `.tsv` — the two
 * columns Prisma cannot read — lives here, and nowhere else.
 *
 * Rules (the raw-SQL edition of docs/guide.md rule 2):
 *  - `organizationId` is a parameter of every function and is in EVERY
 *    WHERE clause, including the joins. There is no "by id" helper.
 *  - Only tagged templates (`$queryRaw\`...${x}\``): every value is a bind
 *    parameter. No string-built SQL, no $queryRawUnsafe.
 *  - Unqualified table names resolve through search_path, which
 *    packages/db pins to the DATABASE_URL schema, then `public` (where the
 *    vector extension lives) — so the same SQL runs in the test schema.
 *  - Vectors cross the wire as pgvector's text form ('[0.1,0.2,…]') and are
 *    cast with ::vector; an existing embedding is copied as text, never
 *    parsed into JS numbers and back.
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@repo/db";

export type Sql = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** Highlight markers ts_headline wraps matches in (Unicode private use). */
export const HIT_START = "";
export const HIT_END = "";

/**
 * The length of document_chunk.embedding: `vector(1536)` in migration
 * rag_documents. Every embedding is requested at this size (OpenAI's
 * text-embedding-3-* shorten natively) and anything else is refused before
 * it reaches SQL. Another size = a migration altering the column (and its
 * HNSW index), this constant, and a re-index of every document.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

export interface ChunkRow {
  ord: number;
  heading: string;
  content: string;
  contentHash: string;
  /** pgvector text form, or null for keyword-only. */
  embedding: string | null;
}

/** Replace a document's chunks wholesale. Call inside a transaction. */
export async function replaceChunks(
  tx: Sql,
  organizationId: string,
  documentId: string,
  rows: ChunkRow[],
): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM document_chunk
    WHERE "organizationId" = ${organizationId} AND "documentId" = ${documentId}`;
  if (rows.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO document_chunk
      (id, "organizationId", "documentId", ord, heading, content, "contentHash", embedding)
    SELECT u.id, ${organizationId}, ${documentId}, u.ord, u.heading, u.content, u.hash, u.emb::vector
    FROM unnest(
      ${rows.map(() => randomUUID())}::text[],
      ${rows.map((r) => r.ord)}::int[],
      ${rows.map((r) => r.heading)}::text[],
      ${rows.map((r) => r.content)}::text[],
      ${rows.map((r) => r.contentHash)}::text[],
      ${rows.map((r) => r.embedding)}::text[]
    ) AS u(id, ord, heading, content, hash, emb)`;
}

/** contentHash → embedding (text form) of a document's embedded chunks. */
export async function embeddingsByHash(
  tx: Sql,
  organizationId: string,
  documentId: string,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<{ contentHash: string; emb: string }[]>`
    SELECT "contentHash", embedding::text AS emb
    FROM document_chunk
    WHERE "organizationId" = ${organizationId} AND "documentId" = ${documentId}
      AND embedding IS NOT NULL`;
  return new Map(rows.map((r) => [r.contentHash, r.emb]));
}

/**
 * The words of a query, OR-ed, for to_tsquery. Only letters and digits reach
 * it, so user text can never be read as tsquery syntax (`!`, `&`, `:*`).
 * Empty when the query has no words.
 */
export function looseQuery(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, 32).join(" | ");
}

export interface Hit {
  id: string;
  score: number;
}

/**
 * Keyword leg. Matches ANY word (recall), ranks by cover density with a +1
 * for chunks that match the query as a whole (websearch syntax: all words,
 * "quoted phrases", -exclusions), so precise matches lead.
 */
export async function keywordSearch(
  tx: Sql,
  organizationId: string,
  query: string,
  limit: number,
): Promise<Hit[]> {
  const loose = looseQuery(query);
  if (!loose) return [];
  return tx.$queryRaw<Hit[]>`
    WITH q AS (
      SELECT to_tsquery('english', ${loose}) AS loose,
             websearch_to_tsquery('english', ${query}) AS strict
    )
    SELECT c.id,
           (ts_rank_cd(c.tsv, q.loose, 1)
             + CASE WHEN c.tsv @@ q.strict THEN 1 ELSE 0 END)::float8 AS score
    FROM document_chunk c, q
    WHERE c."organizationId" = ${organizationId} AND c.tsv @@ q.loose
    ORDER BY score DESC, c."documentId", c.ord
    LIMIT ${limit}`;
}

/**
 * Meaning leg: cosine kNN over this tenant's chunks. MUST run in a
 * transaction (the settings below are transaction-local).
 *
 * The tenant filter is why iterative scan is on: plain HNSW returns its
 * ef_search nearest rows across ALL tenants and only then filters, so a small
 * tenant in a big table gets few or no rows back. pgvector ≥ 0.8 keeps
 * scanning until `limit` rows pass the filter; `relaxed_order` may return
 * them slightly out of order, hence the outer ORDER BY.
 */
export async function vectorSearch(
  tx: Sql,
  organizationId: string,
  embedding: number[],
  limit: number,
): Promise<Hit[]> {
  await tx.$executeRaw`
    SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true),
           set_config('hnsw.ef_search', '100', true)`;
  const v = toVector(embedding);
  const rows = await tx.$queryRaw<{ id: string; distance: number }[]>`
    SELECT id, distance FROM (
      SELECT id, (embedding <=> ${v}::vector)::float8 AS distance
      FROM document_chunk
      WHERE "organizationId" = ${organizationId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${v}::vector
      LIMIT ${limit}
    ) s
    ORDER BY distance, id`;
  return rows.map((r) => ({ id: r.id, score: 1 - r.distance }));
}

export interface ChunkView {
  id: string;
  documentId: string;
  title: string;
  heading: string;
  ord: number;
  content: string;
  /** ts_headline excerpt, matches wrapped in HIT_START … HIT_END. */
  snippet: string;
}

/** The chunks behind `ids` (this tenant's only), with highlighted excerpts. */
export async function chunkViews(
  tx: Sql,
  organizationId: string,
  ids: string[],
  query: string,
): Promise<ChunkView[]> {
  if (ids.length === 0) return [];
  const opts = `MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … ", StartSel="${HIT_START}", StopSel="${HIT_END}"`;
  return tx.$queryRaw<ChunkView[]>`
    SELECT c.id, c."documentId", d.title, c.heading, c.ord, c.content,
           ts_headline('english', c.content,
                       to_tsquery('english', ${looseQuery(query)}), ${opts}) AS snippet
    FROM document_chunk c
    JOIN document d
      ON d.id = c."documentId" AND d."organizationId" = ${organizationId}
    WHERE c."organizationId" = ${organizationId} AND c.id = ANY(${ids}::text[])`;
}
