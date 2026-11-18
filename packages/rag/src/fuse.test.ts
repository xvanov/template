import { describe, expect, it } from "vitest";

import { rrf, RRF_K } from "./fuse";

const ids = (...xs: string[]) => xs.map((id) => ({ id }));

describe("rrf", () => {
  it("rewards agreement between lists over a single first place", () => {
    const out = rrf([
      { name: "keyword", items: ids("a", "b", "c") },
      { name: "meaning", items: ids("x", "b", "y") },
    ]);
    expect(out[0]!.id).toBe("b");
    expect(out[0]!.matchedBy).toEqual(["keyword", "meaning"]);
    expect(out[0]!.ranks).toEqual({ keyword: 2, meaning: 2 });
    expect(out[0]!.score).toBeCloseTo(2 / (RRF_K + 2));
  });

  it("with one empty list is that list's order (keyword-only fallback)", () => {
    const out = rrf([
      { name: "keyword", items: ids("a", "b", "c") },
      { name: "meaning", items: [] },
    ]);
    expect(out.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("applies weights, ignores duplicates within a list, and breaks ties by first seen", () => {
    const out = rrf([
      { name: "k", items: ids("a", "a", "b"), weight: 1 },
      { name: "m", items: ids("b", "a"), weight: 3 },
    ]);
    expect(out[0]!.id).toBe("b"); // 1/62 + 3/61 > 1/61 + 3/62
    expect(out.find((f) => f.id === "a")!.ranks).toEqual({ k: 1, m: 2 });
    expect(
      rrf([
        { name: "k", items: ids("p") },
        { name: "m", items: ids("q") },
      ]).map((f) => f.id),
    ).toEqual(["p", "q"]);
  });
});
