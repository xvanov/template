/**
 * A deterministic, offline stand-in for an embedding model: hashed bag of
 * words (plus character trigrams, so "ports" lands near "port"), L2-normalised.
 * It has no notion of meaning — synonyms do not meet — but it exercises the
 * real vector path (pgvector column, HNSW, cosine kNN, RRF) with no network,
 * for the int tests and the offline eval run. Never use it for real data.
 */
import { createHash } from "node:crypto";

function bucket(token: string, dims: number): number {
  return createHash("md5").update(token).digest().readUInt32LE(0) % dims;
}

export function hashEmbedding(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const w of words) {
    v[bucket(`w:${w}`, dims)]! += 1;
    const padded = `_${w}_`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      v[bucket(`t:${padded.slice(i, i + 3)}`, dims)]! += 0.3;
    }
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
