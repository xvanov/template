import { describe, expect, it } from "vitest";

import { hashEmbedding } from "./fake-embed";
import { snippetParts } from "./search";
import { HIT_END, HIT_START, looseQuery } from "./store";

describe("looseQuery", () => {
  it("keeps only words, so user text is never tsquery syntax", () => {
    expect(looseQuery("port & !3200 :* 'x' | (y)")).toBe("port | 3200 | x | y");
    expect(looseQuery("Größe café")).toBe("größe | café");
    expect(looseQuery("?!")).toBe("");
  });
});

describe("snippetParts", () => {
  it("splits ts_headline output into hit / non-hit runs", () => {
    expect(
      snippetParts(
        `runs on ${HIT_START}port${HIT_END} 3200 ${HIT_START}web${HIT_END}`,
      ),
    ).toEqual([
      { text: "runs on ", hit: false },
      { text: "port", hit: true },
      { text: " 3200 ", hit: false },
      { text: "web", hit: true },
    ]);
  });
});

describe("hashEmbedding", () => {
  it("is deterministic, unit length, and closer for shared words", () => {
    const a = hashEmbedding("database backups nightly", 64);
    expect(hashEmbedding("database backups nightly", 64)).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1);
    const dot = (x: number[], y: number[]) =>
      x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a, hashEmbedding("backup of the database", 64))).toBeGreaterThan(
      dot(a, hashEmbedding("color palette", 64)),
    );
  });
});
