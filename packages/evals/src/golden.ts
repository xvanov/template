/**
 * Golden cases: checked-in JSONL, one case per line, validated on load (a
 * typo in a grader fails loudly with its file and line, not as a 0 score).
 *
 *   {"id": "a-per-diem",                 unique within the file
 *    "input": "How much is the per diem?",
 *    "expected": ["expenses"],           retrieval: relevant corpus files (any order)
 *    "graders": [ ... ],                  see ./graders.ts
 *    "offline": { ... },                  the canned model output for offline runs
 *    "offlineOnly": true,                 a guard test live runs cannot reproduce (a
 *                                         canned bad output, or a path only keyword-only
 *                                         search reaches: the meaning leg always returns
 *                                         nearest neighbours, so "no_sources" never happens live)
 *    "tags": ["answerable"]}
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const path = z
  .string()
  .optional()
  .describe("Dot path into the output; omit for the whole output.");

export const graderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exact"), path, value: z.unknown() }),
  z.object({
    type: z.literal("contains"),
    path,
    value: z.string().min(1),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("regex"),
    path,
    pattern: z.string().min(1),
    flags: z.string().optional(),
  }),
  z.object({
    type: z.literal("schema"),
    path,
    schema: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("judge"), rubric: z.string().min(1) }),
]);
export type Grader = z.infer<typeof graderSchema>;

export const caseSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expected: z.array(z.string()).optional(),
  graders: z.array(graderSchema).default([]),
  offline: z.unknown().optional(),
  offlineOnly: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});
export type GoldenCase = z.infer<typeof caseSchema>;

export const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
export const GOLDEN_DIR = resolve(PACKAGE_ROOT, "golden");
export const CORPUS_DIR = resolve(PACKAGE_ROOT, "fixtures/corpus");

export function parseGolden(text: string, file = "<inline>"): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("//")) return;
    const where = `${file}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`${where}: not JSON (${(err as Error).message})`);
    }
    const parsed = caseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `${where}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`,
      );
    }
    if (ids.has(parsed.data.id))
      throw new Error(`${where}: duplicate id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    cases.push(parsed.data);
  });
  return cases;
}

export function loadGolden(name: string): GoldenCase[] {
  const file = resolve(GOLDEN_DIR, `${name}.jsonl`);
  return parseGolden(readFileSync(file, "utf8"), `golden/${name}.jsonl`);
}
