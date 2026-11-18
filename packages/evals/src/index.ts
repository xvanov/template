/**
 * The eval harness: golden sets (golden/*.jsonl), graders, retrieval
 * metrics, offline/live runner, baselines. CLI: `npm run eval` (src/cli.ts).
 * How to add a case: docs/guide.md, "Evals".
 */
export {
  baselineKey,
  compare,
  loadBaseline,
  saveBaseline,
  toBaseline,
  type Baseline,
} from "./baseline";
export {
  loadGolden,
  parseGolden,
  type GoldenCase,
  type Grader,
} from "./golden";
export { combine, grade, type GradeResult, type Judge } from "./graders";
export { llmJudge } from "./judge";
export { mean, recallAtK, reciprocalRank } from "./metrics";
export {
  K,
  replayModel,
  runEvals,
  SUITES,
  type Report,
  type RunOptions,
  type SuiteName,
} from "./runner";
export { formatReport } from "./table";
