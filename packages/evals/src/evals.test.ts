import { describe, expect, it } from "vitest";

import { compare, toBaseline } from "./baseline";
import { parseGolden } from "./golden";
import { combine, grade } from "./graders";
import { recallAtK, reciprocalRank } from "./metrics";
import type { Report } from "./runner";

describe("graders", () => {
  const out = {
    status: "answered",
    answer: "The per diem is 65 EUR.",
    citations: [{ n: 1 }],
  };

  it("exact / contains / regex read a dot path", async () => {
    expect(
      (
        await grade(
          { type: "exact", path: "status", value: "answered" },
          out,
          "q",
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await grade(
          { type: "exact", path: "citations.0.n", value: 1 },
          out,
          "q",
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await grade(
          { type: "contains", path: "answer", value: "eur" },
          out,
          "q",
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await grade(
          {
            type: "contains",
            path: "answer",
            value: "eur",
            caseSensitive: true,
          },
          out,
          "q",
        )
      ).pass,
    ).toBe(false);
    const r = await grade(
      { type: "regex", path: "answer", pattern: "\\b70\\b" },
      out,
      "q",
    );
    expect(r).toMatchObject({
      pass: false,
      score: 0,
      detail: expect.stringContaining("/\\b70\\b/"),
    });
  });

  it("schema validates JSON Schema", async () => {
    const schema = {
      type: "object",
      required: ["status"],
      properties: { status: { const: "answered" } },
    };
    expect((await grade({ type: "schema", schema }, out, "q")).pass).toBe(true);
    expect(
      (await grade({ type: "schema", schema }, { status: "unknown" }, "q"))
        .pass,
    ).toBe(false);
  });

  it("judge is skipped (and not scored) unless a judge is given", async () => {
    const skipped = await grade({ type: "judge", rubric: "r" }, out, "q");
    expect(skipped).toMatchObject({ skipped: true });
    expect(
      combine([skipped, { grader: "exact", pass: true, score: 1 }]),
    ).toEqual({ score: 1, pass: true });
    const judged = await grade(
      { type: "judge", rubric: "r" },
      out,
      "q",
      async () => ({
        pass: false,
        score: 0.4,
        reason: "missing the cite",
        costUsd: 0.01,
      }),
    );
    expect(judged).toMatchObject({
      pass: false,
      score: 0.4,
      costUsd: 0.01,
      detail: "missing the cite",
    });
  });
});

describe("metrics", () => {
  it("recall@k and reciprocal rank over documents, duplicates collapsed", () => {
    expect(reciprocalRank(["a", "a", "b"], ["b"], 5)).toBe(1 / 2);
    expect(reciprocalRank(["a", "b"], ["c"], 5)).toBe(0);
    expect(reciprocalRank(["a", "b", "c"], ["c"], 2)).toBe(0);
    expect(recallAtK(["a", "b", "c"], ["a", "c", "z"], 3)).toBeCloseTo(2 / 3);
  });
});

describe("golden files", () => {
  it("reject bad lines with file and line", () => {
    expect(() =>
      parseGolden('{"id":"x","input":"q"}\n{"id":"x","input":"q"}', "f"),
    ).toThrow("f:2: duplicate id x");
    expect(() =>
      parseGolden('{"id":"x","input":"q","graders":[{"type":"nope"}]}', "f"),
    ).toThrow(/^f:1: graders/);
    expect(() => parseGolden("{oops", "f")).toThrow(/^f:1: not JSON/);
    expect(parseGolden('\n// comment\n{"id":"x","input":"q"}')).toHaveLength(1);
  });
});

describe("baseline comparison", () => {
  const report = (score: number, failing: string[] = []): Report => ({
    mode: "offline",
    model: null,
    startedAt: "t",
    durationMs: 0,
    suites: {
      answer: {
        score,
        passed: 0,
        total: 2,
        skipped: 0,
        costUsd: 0,
        latencyP50Ms: 0,
        metrics: {},
        notes: [],
        cases: ["c1", "c2"].map((id) => ({
          id,
          tags: [],
          score: 1,
          pass: !failing.includes(id),
          costUsd: 0,
          latencyMs: 0,
        })),
      },
    },
  });

  it("fails on a drop beyond the threshold, and on a newly failing case at threshold 0", () => {
    const base = toBaseline(report(0.9, ["c2"]));
    expect(compare(report(0.8), base, 0.05).regressions).toEqual(["answer"]);
    expect(compare(report(0.88), base, 0.05).regressions).toEqual([]);
    // Same mean, but c1 broke while c2 got fixed: caught offline.
    expect(compare(report(0.9, ["c1"]), base, 0).regressions).toEqual([
      "answer",
    ]);
    expect(compare(report(0.95), base, 0)).toMatchObject({
      regressions: [],
      improvements: ["answer"],
    });
    expect(compare(report(0.5), null, 0).lines[0]).toMatch(/no baseline/);
  });
});
