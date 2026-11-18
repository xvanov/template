/**
 * Hybrid search: keyword (Postgres FTS) + meaning (pgvector kNN), merged
 * with Reciprocal Rank Fusion (./fuse.ts).
 *
 * Keyword search always runs and stands on its own: with embeddings off (the
 * smoke gate, CI, a tenant over its AI cap, a provider outage) the answer is
 * keyword-only, and the result says so and why (`keywordOnly`). Nothing here
 * throws because the AI is unavailable.
 *
 * The query is embedded BEFORE the database work starts, so a slow provider
 * never holds a transaction open.
 */
import {
  embed,
  LlmBudgetExceededError,
  LlmConfigError,
  LlmDisabledError,
  LlmUnpricedError,
} from "@repo/ai";
import { env } from "@repo/env";

import { rrf } from "./fuse";
import {
  chunkViews,
  HIT_END,
  HIT_START,
  keywordSearch,
  vectorSearch,
  EMBEDDING_DIMENSIONS,
  type Sql,
} from "./store";

/** Runs `fn` in a transaction: `(fn) => db.$transaction(fn)`, or `(fn) => fn(tx)` inside one. */
export type InTx = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;

/** Embed a query, or say why not. Never throws for "AI unavailable". */
export type EmbedQuery = (
  query: string,
  who: { organizationId: string; userId?: string | null },
) => Promise<{ vector: number[] } | { unavailable: string }>;

export interface SearchInput {
  query: string;
  /** Default 8. */
  limit?: number;
  /** "keyword" skips the embedding call (and its cost) entirely. */
  mode?: "hybrid" | "keyword";
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  /** Heading path, title first. */
  heading: string;
  ord: number;
  content: string;
  /** Plain-text excerpt. */
  snippet: string;
  /** The same excerpt, split into matched / unmatched runs, for highlighting. */
  snippetParts: SnippetPart[];
  score: number;
  /** "keyword", "meaning", or both. */
  matchedBy: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  mode: "hybrid" | "keyword";
  /** Why the meaning leg did not run, when it did not. */
  keywordOnly?: string;
}

/** Expected states of the AI seam: degrade to keyword search, do not fail. */
export function unavailableReason(err: unknown): string | null {
  if (err instanceof LlmDisabledError) return "embeddings are off";
  if (err instanceof LlmBudgetExceededError)
    return "the workspace's daily AI budget is used up";
  if (err instanceof LlmUnpricedError)
    return "the embedding model has no price";
  if (err instanceof LlmConfigError) return `embedding config: ${err.message}`;
  return null;
}

export const embedQueryWithAi: EmbedQuery = async (query, who) => {
  const e = env();
  if (!e.LLM_ENABLED || !e.LLM_EMBEDDING_MODEL) {
    return { unavailable: "embeddings are off" };
  }
  try {
    const r = await embed({
      texts: [query],
      dimensions: EMBEDDING_DIMENSIONS,
      purpose: "docs.search",
      // A search must not be blocked by the cap: it falls back instead.
      priority: "discretionary",
      organizationId: who.organizationId,
      userId: who.userId ?? null,
    });
    return { vector: r.embeddings[0]! };
  } catch (err) {
    const reason = unavailableReason(err);
    if (reason) return { unavailable: reason };
    console.warn("[rag] query embedding failed — keyword-only:", err);
    return { unavailable: "the embedding provider failed" };
  }
};

export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const re = new RegExp(`${HIT_START}([^${HIT_END}]*)${HIT_END}`, "g");
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m.index > last)
      parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1]!, hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length)
    parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

export async function searchDocs(
  inTx: InTx,
  who: { organizationId: string; userId?: string | null },
  input: SearchInput,
  deps: { embedQuery?: EmbedQuery } = {},
): Promise<SearchResult> {
  const query = input.query.trim();
  const limit = input.limit ?? 8;
  if (!query) return { hits: [], mode: "keyword", keywordOnly: "empty query" };
  const pool = Math.max(20, limit * 4);

  let vector: number[] | null = null;
  let keywordOnly: string | undefined;
  if (input.mode === "keyword") {
    keywordOnly = "keyword mode requested";
  } else {
    const r = await (deps.embedQuery ?? embedQueryWithAi)(query, who);
    if (!("vector" in r)) keywordOnly = r.unavailable;
    else if (r.vector.length !== EMBEDDING_DIMENSIONS) {
      // Would be a SQL error inside the transaction: degrade instead.
      keywordOnly = `the query embedding has ${r.vector.length} dimensions, the index ${EMBEDDING_DIMENSIONS}`;
    } else vector = r.vector;
  }

  return inTx(async (tx) => {
    const keyword = await keywordSearch(tx, who.organizationId, query, pool);
    const meaning = vector
      ? await vectorSearch(tx, who.organizationId, vector, pool)
      : [];
    const fused = rrf([
      { name: "keyword", items: keyword },
      { name: "meaning", items: meaning },
    ]).slice(0, limit);
    const views = new Map(
      (
        await chunkViews(
          tx,
          who.organizationId,
          fused.map((f) => f.id),
          query,
        )
      ).map((v) => [v.id, v]),
    );
    const hits: SearchHit[] = [];
    for (const f of fused) {
      const v = views.get(f.id);
      if (!v) continue;
      const parts = snippetParts(v.snippet);
      hits.push({
        chunkId: v.id,
        documentId: v.documentId,
        title: v.title,
        heading: v.heading,
        ord: v.ord,
        content: v.content,
        snippet: parts.map((p) => p.text).join(""),
        snippetParts: parts,
        score: f.score,
        matchedBy: f.matchedBy,
      });
    }
    return {
      hits,
      mode: vector ? "hybrid" : "keyword",
      ...(keywordOnly ? { keywordOnly } : {}),
    };
  });
}
