/**
 * Graders: each turns (grader, output) into a score in [0, 1] and a pass.
 *
 *   exact     deep-equal at `path`                      {"type":"exact","path":"status","value":"answered"}
 *   contains  substring at `path` (case-insensitive)    {"type":"contains","path":"answer","value":"65"}
 *   regex     pattern at `path`                         {"type":"regex","path":"answer","pattern":"deploy\\.sh"}
 *   schema    JSON Schema validity at `path`            {"type":"schema","schema":{"type":"object",...}}
 *   judge     LLM-as-judge against a rubric             {"type":"judge","rubric":"States 65 EUR ..."}
 *
 * The judge costs money and is not deterministic, so it runs only when the
 * run was started with --judge; otherwise it is reported as skipped and left
 * out of the score. Retrieval cases are scored by ./metrics.ts instead.
 */
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { Grader } from "./golden";

export interface GradeResult {
  grader: Grader["type"];
  pass: boolean;
  score: number;
  detail?: string;
  skipped?: boolean;
  costUsd?: number;
}

/** Grades an output against a rubric. Provided only for --judge runs. */
export type Judge = (args: {
  rubric: string;
  input: string;
  output: unknown;
}) => Promise<{
  pass: boolean;
  score: number;
  reason: string;
  costUsd: number;
}>;

export function at(output: unknown, path?: string): unknown {
  if (!path) return output;
  let cur: unknown = output;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const text = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v ?? "");
const verdict = (
  grader: Grader["type"],
  pass: boolean,
  detail?: string,
): GradeResult => ({
  grader,
  pass,
  score: pass ? 1 : 0,
  ...(pass || !detail ? {} : { detail }),
});

export async function grade(
  g: Grader,
  output: unknown,
  input: string,
  judge?: Judge,
): Promise<GradeResult> {
  switch (g.type) {
    case "exact": {
      const got = at(output, g.path);
      return verdict(
        "exact",
        isDeepStrictEqual(got, g.value),
        `${g.path ?? "output"}: expected ${JSON.stringify(g.value)}, got ${JSON.stringify(got)}`,
      );
    }
    case "contains": {
      const got = text(at(output, g.path));
      const ok = g.caseSensitive
        ? got.includes(g.value)
        : got.toLowerCase().includes(g.value.toLowerCase());
      return verdict(
        "contains",
        ok,
        `${g.path ?? "output"} lacks "${g.value}"`,
      );
    }
    case "regex": {
      const got = text(at(output, g.path));
      return verdict(
        "regex",
        new RegExp(g.pattern, g.flags).test(got),
        `${g.path ?? "output"} does not match /${g.pattern}/`,
      );
    }
    case "schema": {
      const r = z.fromJSONSchema(g.schema).safeParse(at(output, g.path));
      return verdict(
        "schema",
        r.success,
        r.success
          ? undefined
          : r.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; "),
      );
    }
    case "judge": {
      if (!judge) {
        return {
          grader: "judge",
          pass: true,
          score: 0,
          skipped: true,
          detail: "run with --judge",
        };
      }
      const j = await judge({ rubric: g.rubric, input, output });
      return {
        grader: "judge",
        pass: j.pass,
        score: Math.max(0, Math.min(1, j.score)),
        costUsd: j.costUsd,
        ...(j.pass ? {} : { detail: j.reason }),
      };
    }
  }
}

/** A case's score: the mean of its non-skipped grades; passes if all do. */
export function combine(grades: GradeResult[]): {
  score: number;
  pass: boolean;
} {
  const counted = grades.filter((g) => !g.skipped);
  if (counted.length === 0) return { score: 1, pass: true };
  return {
    score: counted.reduce((s, g) => s + g.score, 0) / counted.length,
    pass: counted.every((g) => g.pass),
  };
}
