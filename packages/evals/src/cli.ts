/**
 * npm run eval                                   offline: fakes + FTS, ~1s, free
 * npm run eval -- --live --model anthropic/claude-opus-5-5
 *                                                real providers (keys from .env)
 *   --judge [--judge-model p/m]    also run LLM-as-judge graders (costs money)
 *   --suite retrieval|answer       one suite (repeatable)
 *   --threshold 0.05               allowed score drop before failing
 *   --save-baseline                accept this run as the new baseline
 *   --failures                     print only failing cases
 *
 * Runs in a throwaway, migrated schema (never your dev data), prints a table,
 * writes the full JSON report to packages/evals/reports/ (gitignored), and
 * exits 1 when a suite regresses beyond the threshold vs its baseline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    model: { type: "string" },
    judge: { type: "boolean", default: false },
    "judge-model": { type: "string" },
    suite: { type: "string", multiple: true },
    threshold: { type: "string" },
    "save-baseline": { type: "boolean", default: false },
    failures: { type: "boolean", default: false },
  },
});

if (values.live) {
  // Provider keys and models come from the root .env, as for the app.
  await import("@repo/env/load");
} else {
  // Offline: nothing may reach a provider, whatever the shell or .env says.
  process.env.LLM_ENABLED = "false";
  if (values.judge) {
    console.error("--judge needs --live (the judge is a real model).");
    process.exit(2);
  }
}
// env() validates these at first use; a bare checkout has no .env.
process.env.REDIS_URL ??= "redis://127.0.0.1:1";
process.env.BETTER_AUTH_SECRET ??= "evals-secret-not-for-production-use-32+";
process.env.APP_URL ??= "http://localhost:3200";

const { createThrowawaySchema } = await import("@repo/db/testing");
const schema = await createThrowawaySchema();
process.env.DATABASE_URL = schema.url;

let code = 0;
try {
  const { resetEnvCache } = await import("@repo/env");
  resetEnvCache();
  const { db } = await import("@repo/db");
  const { runEvals, SUITES } = await import("./runner");
  const { llmJudge } = await import("./judge");
  const { formatReport } = await import("./table");
  const { baselineKey, compare, loadBaseline, saveBaseline, toBaseline } =
    await import("./baseline");
  const { PACKAGE_ROOT } = await import("./golden");

  const suites = (values.suite ?? [...SUITES]) as (typeof SUITES)[number][];
  for (const s of suites) {
    if (!SUITES.includes(s))
      throw new Error(`unknown suite ${s} (have: ${SUITES.join(", ")})`);
  }
  const report = await runEvals({
    mode: values.live ? "live" : "offline",
    model: values.model,
    suites,
    judge: values.judge
      ? llmJudge({ model: values["judge-model"] ?? values.model })
      : undefined,
  });
  console.log(formatReport(report, { failuresOnly: values.failures }));

  const dir = resolve(PACKAGE_ROOT, "reports");
  mkdirSync(dir, { recursive: true });
  const file = resolve(
    dir,
    `${report.startedAt.replace(/[:.]/g, "-")}-${baselineKey(report)}.json`,
  );
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${file}`);

  const threshold = Number(values.threshold ?? (values.live ? 0.05 : 0));
  const result = compare(report, loadBaseline(baselineKey(report)), threshold);
  for (const line of result.lines) console.log(line);
  if (values["save-baseline"]) {
    console.log(`baseline saved: ${saveBaseline(toBaseline(report))}`);
  } else if (result.regressions.length) {
    code = 1;
  }
  await db.$disconnect();
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  code = 1;
} finally {
  await schema.drop();
}
process.exit(code);
