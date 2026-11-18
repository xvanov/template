/**
 * Runs the suites against a database the caller has already pointed
 * DATABASE_URL at (a throwaway schema: see ./cli.ts and test/offline.int.test.ts).
 *
 *   retrieval  the fixture corpus is ingested; each golden query is searched
 *              and scored by reciprocal rank of the first relevant document
 *              (top K) — the suite score is MRR; recall@K rides along.
 *              offline: keyword (FTS) only — deterministic.
 *              live:    hybrid, with the embedding model from .env.
 *   answer     answerQuestion() over the same corpus, graded per case.
 *              offline: the model is a fake that replays the case's
 *                       `offline` output, so what is tested is everything
 *                       AROUND the model — retrieval, prompt sources,
 *                       citation and grounding checks, routing to "unknown".
 *              live:    the real model (`--model provider/model`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { askObject as realAskObject } from "@repo/ai";
import { db } from "@repo/db";
import { createTenant } from "@repo/db/testing";
import {
  answerQuestion,
  createDocument,
  ingestDocument,
  quoteFound,
  searchDocs,
  type AnswerResult,
  type InTx,
} from "@repo/rag";
import { z } from "zod";

import { CORPUS_DIR, loadGolden, type GoldenCase } from "./golden";
import { combine, grade, type GradeResult, type Judge } from "./graders";
import { mean, percentile, recallAtK, reciprocalRank } from "./metrics";

export const SUITES = ["retrieval", "answer"] as const;
export type SuiteName = (typeof SUITES)[number];
export const K = 5;

export interface RunOptions {
  mode: "offline" | "live";
  /** Live answer model, `provider/model`. Default: the "default" tier. */
  model?: string;
  judge?: Judge;
  suites?: SuiteName[];
}

export interface CaseResult {
  id: string;
  tags: string[];
  score: number;
  pass: boolean;
  costUsd: number;
  latencyMs: number;
  grades?: GradeResult[];
  /** retrieval: the documents returned (top K), best first. */
  got?: string[];
  /** retrieval: recall@K for this case. */
  recall?: number;
  detail?: string;
}

export interface SuiteResult {
  score: number;
  passed: number;
  total: number;
  skipped: number;
  costUsd: number;
  latencyP50Ms: number;
  metrics: Record<string, number>;
  notes: string[];
  cases: CaseResult[];
}

export interface Report {
  mode: "offline" | "live";
  model: string | null;
  startedAt: string;
  durationMs: number;
  suites: Partial<Record<SuiteName, SuiteResult>>;
}

const inTx: InTx = (fn) => db.$transaction((tx) => fn(tx));

/** Ingest the fixture corpus into a fresh tenant. Title = file name (the gold id). */
async function loadCorpus(live: boolean) {
  const t = await createTenant("evals");
  const actor = { organizationId: t.organizationId, userId: t.userId };
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const notes = new Set<string>();
  for (const file of files) {
    const doc = await db.$transaction((tx) =>
      createDocument(
        tx,
        actor,
        {
          title: file.replace(/\.md$/, ""),
          content: readFileSync(resolve(CORPUS_DIR, file), "utf8"),
          contentType: "text/markdown",
        },
        async () => {},
      ),
    );
    const r = await ingestDocument(
      { organizationId: t.organizationId, documentId: doc.id },
      live ? {} : { embeddingModel: () => null },
    );
    if (r.status !== "indexed")
      throw new Error(`corpus ${file}: ${r.status} ${r.note ?? ""}`);
    if (live && r.note)
      notes.add(`corpus indexed without (all) embeddings: ${r.note}`);
  }
  return {
    who: { organizationId: t.organizationId, userId: t.userId },
    notes: [...notes],
  };
}

async function spentSince(
  organizationId: string,
  since: Date,
): Promise<number> {
  const r = await db.llmCall.aggregate({
    where: { organizationId, createdAt: { gte: since } },
    _sum: { costUsd: true },
  });
  return r._sum.costUsd ?? 0;
}

function summarize(
  cases: CaseResult[],
  extra: Partial<SuiteResult> = {},
): SuiteResult {
  return {
    score: mean(cases.map((c) => c.score)),
    passed: cases.filter((c) => c.pass).length,
    total: cases.length,
    skipped: 0,
    costUsd: cases.reduce((s, c) => s + c.costUsd, 0),
    latencyP50Ms: percentile(
      cases.map((c) => c.latencyMs),
      50,
    ),
    metrics: {},
    notes: [],
    cases,
    ...extra,
  };
}

async function retrievalSuite(
  opts: RunOptions,
  who: { organizationId: string; userId: string },
): Promise<SuiteResult> {
  const live = opts.mode === "live";
  const cases: CaseResult[] = [];
  const notes = new Set<string>();
  for (const c of loadGolden("retrieval")) {
    const started = Date.now();
    const r = await searchDocs(inTx, who, {
      query: c.input,
      limit: 10,
      mode: live ? "hybrid" : "keyword",
    });
    if (live && r.keywordOnly) notes.add(`keyword-only: ${r.keywordOnly}`);
    const got = [...new Set(r.hits.map((h) => h.title))];
    const relevant = c.expected ?? [];
    const rr = reciprocalRank(got, relevant, K);
    const recall = recallAtK(got, relevant, K);
    cases.push({
      id: c.id,
      tags: c.tags,
      score: rr,
      pass: rr > 0,
      costUsd: 0,
      latencyMs: Date.now() - started,
      got: got.slice(0, K),
      recall,
      ...(rr > 0
        ? {}
        : {
            detail: `expected ${relevant.join("|")}, got ${got.slice(0, K).join(", ") || "nothing"}`,
          }),
    });
  }
  const recalls = cases.map((c) => c.recall ?? 0);
  return summarize(cases, {
    metrics: {
      mrr: mean(cases.map((c) => c.score)),
      [`recall@${K}`]: mean(recalls),
      "recall@1": mean(cases.map((c) => (c.score === 1 ? 1 : 0))),
    },
    notes: [...notes],
  });
}

/** Offline stand-in for askObject: replays `offline`, citing by quote. */
export function replayModel(fixture: unknown): typeof realAskObject {
  const f = z
    .object({
      known: z.boolean(),
      answer: z.string(),
      quotes: z.array(z.string()),
    })
    .parse(fixture);
  const fake = async (opts: { prompt: string }) => {
    // The prompt's sources are "[n] heading\ncontent", separated by "---".
    const sources = opts.prompt
      .split("\n\n---\n\n")
      .filter((s) => /^\[\d+\]/.test(s));
    const citations = f.quotes.map((quote) => {
      const i = sources.findIndex((s) => quoteFound(s, quote));
      // A quote in no source keeps a source number, as a model's would, so
      // the citation check (not this fake) is what rejects it.
      return { source: i >= 0 ? i + 1 : 1, quote };
    });
    return {
      ok: true as const,
      object: { known: f.known, answer: f.answer, citations },
      model: "offline/replay",
      servedBy: "offline/replay",
      provider: "offline",
      tier: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      costUsd: 0,
      costKnown: true,
      latencyMs: 0,
    };
  };
  return fake as unknown as typeof realAskObject;
}

function flatten(r: AnswerResult): Record<string, unknown> {
  return r.status === "answered"
    ? {
        status: r.status,
        answer: r.answer,
        citations: r.citations,
        model: r.model,
      }
    : {
        status: r.status,
        reason: r.reason,
        detail: r.detail,
        sources: r.sources,
      };
}

async function answerSuite(
  opts: RunOptions,
  who: { organizationId: string; userId: string },
): Promise<SuiteResult> {
  const live = opts.mode === "live";
  const cases: CaseResult[] = [];
  let skipped = 0;
  for (const c of loadGolden("answer") as GoldenCase[]) {
    if (live && c.offlineOnly) {
      skipped++;
      continue;
    }
    const started = Date.now();
    const result = await answerQuestion(
      inTx,
      who,
      c.input,
      live
        ? { ...(opts.model ? { model: opts.model } : {}) }
        : {
            askObject: replayModel(c.offline),
            embedQuery: async () => ({ unavailable: "offline" }),
          },
    );
    const latencyMs = Date.now() - started;
    const output = flatten(result);
    const grades = await Promise.all(
      c.graders.map((g) => grade(g, output, c.input, opts.judge)),
    );
    const { score, pass } = combine(grades);
    const failed = grades.filter((g) => !g.pass && !g.skipped);
    cases.push({
      id: c.id,
      tags: c.tags,
      score,
      pass,
      costUsd:
        result.costUsd + grades.reduce((s, g) => s + (g.costUsd ?? 0), 0),
      latencyMs,
      grades,
      ...(failed.length
        ? { detail: failed.map((g) => g.detail).join("; ") }
        : {}),
    });
  }
  return summarize(cases, {
    skipped,
    metrics: { pass_rate: mean(cases.map((c) => (c.pass ? 1 : 0))) },
    notes: skipped ? [`${skipped} offline-only guard case(s) skipped`] : [],
  });
}

export async function runEvals(opts: RunOptions): Promise<Report> {
  const started = new Date();
  const suites = opts.suites ?? [...SUITES];
  const live = opts.mode === "live";
  const corpus = await loadCorpus(live);
  const report: Report = {
    mode: opts.mode,
    model: live ? (opts.model ?? "tier:default") : null,
    startedAt: started.toISOString(),
    durationMs: 0,
    suites: {},
  };
  for (const name of suites) {
    const since = new Date();
    const r =
      name === "retrieval"
        ? await retrievalSuite(opts, corpus.who)
        : await answerSuite(opts, corpus.who);
    r.notes.unshift(...corpus.notes);
    // Everything the suite spent, embeddings and judge included (llm_call).
    if (live)
      r.costUsd = Math.max(
        r.costUsd,
        await spentSince(corpus.who.organizationId, since),
      );
    report.suites[name] = r;
  }
  report.durationMs = Date.now() - started.getTime();
  return report;
}
