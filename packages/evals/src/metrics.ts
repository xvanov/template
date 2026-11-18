/**
 * Retrieval metrics over document ids, pure. Gold is a DOCUMENT (a corpus
 * file), not a chunk: re-chunking must not invalidate the golden set.
 *
 *   recall@k   share of the relevant documents found in the top k
 *   RR         1 / rank of the first relevant document (0 if none in the top k);
 *              its mean over cases is MRR
 */
export function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function recallAtK(
  ranked: string[],
  relevant: string[],
  k: number,
): number {
  if (relevant.length === 0) return 1;
  const top = new Set(dedupe(ranked).slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function reciprocalRank(
  ranked: string[],
  relevant: string[],
  k: number,
): number {
  const rel = new Set(relevant);
  const i = dedupe(ranked)
    .slice(0, k)
    .findIndex((id) => rel.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
