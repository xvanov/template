/**
 * Baselines: the last accepted score per suite, checked in under
 * baselines/<key>.json — `offline` for the deterministic run, and
 * `live-<provider>-<model>` per live model (scores differ by model).
 *
 * A run REGRESSES when a suite's score drops by more than the threshold
 * below its baseline (offline default 0: it is deterministic, any drop is
 * real; live default 0.05: models are noisy). With threshold 0 a case that
 * passed in the baseline and fails now is a regression too, even if another
 * case's gain hides it in the mean. Improvements never fail; they
 * print a reminder to save the new baseline (`--save-baseline`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { PACKAGE_ROOT } from "./golden";
import type { Report, SuiteName } from "./runner";

export const BASELINE_DIR = resolve(PACKAGE_ROOT, "baselines");

export interface Baseline {
  key: string;
  savedAt: string;
  suites: Partial<
    Record<
      SuiteName,
      { score: number; metrics: Record<string, number>; passing?: string[] }
    >
  >;
}

export function baselineKey(report: Pick<Report, "mode" | "model">): string {
  if (report.mode === "offline") return "offline";
  return `live-${(report.model ?? "default").replace(/[^a-zA-Z0-9.-]+/g, "-")}`;
}

export function toBaseline(report: Report): Baseline {
  const suites: Baseline["suites"] = {};
  for (const [name, s] of Object.entries(report.suites)) {
    suites[name as SuiteName] = {
      score: round(s.score),
      metrics: roundAll(s.metrics),
      passing: s.cases.filter((c) => c.pass).map((c) => c.id),
    };
  }
  return { key: baselineKey(report), savedAt: report.startedAt, suites };
}

export function loadBaseline(key: string, dir = BASELINE_DIR): Baseline | null {
  const file = resolve(dir, `${key}.json`);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Baseline)
    : null;
}

export function saveBaseline(b: Baseline, dir = BASELINE_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${b.key}.json`);
  writeFileSync(file, `${JSON.stringify(b, null, 2)}\n`);
  return file;
}

export interface Comparison {
  regressions: string[];
  improvements: string[];
  lines: string[];
}

export function compare(
  report: Report,
  baseline: Baseline | null,
  threshold: number,
): Comparison {
  const out: Comparison = { regressions: [], improvements: [], lines: [] };
  if (!baseline) {
    out.lines.push(
      `no baseline "${baselineKey(report)}" yet — save one with --save-baseline`,
    );
    return out;
  }
  for (const [name, s] of Object.entries(report.suites)) {
    const was = baseline.suites[name as SuiteName];
    if (!was) {
      out.lines.push(`${name}: new suite (no baseline)`);
      continue;
    }
    const delta = round(s.score) - was.score;
    const line = `${name}: ${fmt(s.score)} vs baseline ${fmt(was.score)} (${delta >= 0 ? "+" : ""}${fmt(delta)})`;
    if (delta < -threshold - 1e-9) {
      out.regressions.push(name);
      out.lines.push(`✗ ${line} — regression beyond ${threshold}`);
    } else if (threshold === 0 && newlyFailing(s, was).length) {
      out.regressions.push(name);
      out.lines.push(
        `✗ ${line} — now failing: ${newlyFailing(s, was).join(", ")}`,
      );
    } else if (delta > 1e-9) {
      out.improvements.push(name);
      out.lines.push(`↑ ${line} — save it with --save-baseline`);
    } else out.lines.push(`✓ ${line}`);
  }
  return out;
}

function newlyFailing(
  s: Report["suites"][SuiteName] & object,
  was: { passing?: string[] },
): string[] {
  const failing = new Set(s.cases.filter((c) => !c.pass).map((c) => c.id));
  return (was.passing ?? []).filter((id) => failing.has(id));
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const roundAll = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));
const fmt = (x: number) => x.toFixed(3);
