/**
 * The regression gate inside `make test`: the offline eval run (fake model,
 * FTS-only retrieval, the real Postgres search and answer checks) must not
 * score below baselines/offline.json. Deterministic, no network, ~300 ms.
 *
 * If this fails after an intended change, look at the case table in the
 * output, then accept the new numbers: `npm run eval -- --save-baseline`.
 */
import { expect, it } from "vitest";
import { resetEnvCache } from "@repo/env";

import { baselineKey, compare, loadBaseline } from "../src/baseline";
import { runEvals } from "../src/runner";
import { formatReport } from "../src/table";

process.env.LLM_ENABLED = "false";
resetEnvCache();

it("offline evals do not regress against the checked-in baseline", async () => {
  const report = await runEvals({ mode: "offline" });
  const result = compare(report, loadBaseline(baselineKey(report)), 0);
  if (result.regressions.length) {
    console.log(formatReport(report, { failuresOnly: true }));
  }
  expect(result.lines.join("\n")).not.toMatch(/no baseline/);
  expect(result.regressions, result.lines.join("\n")).toEqual([]);
});
