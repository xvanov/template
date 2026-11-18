/**
 * Reciprocal Rank Fusion: merge ranked lists by position, not by score.
 *
 *   score(d) = Σ_lists  weight / (K + rank_in_list(d))     (rank from 1)
 *
 * Why ranks: a ts_rank and a cosine distance are on unrelated scales, and
 * normalising them to [0,1] per query invents a precision neither has. RRF
 * only trusts each retriever's ORDER, which is the one thing both do well.
 * K = 60 is the constant from the original paper (Cormack et al., 2009) and
 * the one both of the user's earlier systems settled on; it flattens the
 * head enough that a hit ranked 1st by one leg and absent from the other does
 * not automatically beat one ranked 3rd by both.
 */
export const RRF_K = 60;

export interface Ranked {
  id: string;
}

export interface Fused {
  id: string;
  score: number;
  /** Which lists found it, e.g. ["keyword", "meaning"]. */
  matchedBy: string[];
  /** 1-based rank in each list that found it. */
  ranks: Record<string, number>;
}

export function rrf(
  lists: { name: string; items: Ranked[]; weight?: number }[],
  k: number = RRF_K,
): Fused[] {
  const byId = new Map<string, Fused>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    const seen = new Set<string>();
    list.items.forEach((item, i) => {
      if (seen.has(item.id)) return; // a duplicate cannot vote twice
      seen.add(item.id);
      const entry = byId.get(item.id) ?? {
        id: item.id,
        score: 0,
        matchedBy: [],
        ranks: {},
      };
      entry.score += weight / (k + i + 1);
      entry.matchedBy.push(list.name);
      entry.ranks[list.name] = i + 1;
      byId.set(item.id, entry);
    });
  }
  // Ties (same score) break by first appearance: deterministic output.
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
