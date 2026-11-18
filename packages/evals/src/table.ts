/** Plain-text report for the terminal: one row per case, a summary per suite. */
import type { Report } from "./runner";

function pad(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => r[i]!.length)),
  );
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const usd = (x: number) => `$${x.toFixed(4)}`;

export function formatReport(
  report: Report,
  opts: { failuresOnly?: boolean } = {},
): string {
  const out: string[] = [
    `eval ${report.mode}${report.model ? ` · ${report.model}` : ""} · ${(report.durationMs / 1000).toFixed(1)}s`,
  ];
  for (const [name, s] of Object.entries(report.suites)) {
    out.push("");
    const rows = [["case", "score", "pass", "cost", "ms", "detail"]];
    for (const c of s.cases) {
      if (opts.failuresOnly && c.pass) continue;
      rows.push([
        c.id,
        c.score.toFixed(2),
        c.pass ? "✓" : "✗",
        usd(c.costUsd),
        String(c.latencyMs),
        c.detail ?? "",
      ]);
    }
    const metrics = Object.entries(s.metrics)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`)
      .join(" · ");
    out.push(
      `${name}: score ${s.score.toFixed(3)} · ${s.passed}/${s.total} passed${s.skipped ? ` (${s.skipped} skipped)` : ""} · ${metrics} · cost ${usd(s.costUsd)} · p50 ${s.latencyP50Ms}ms`,
    );
    for (const n of s.notes) out.push(`  note: ${n}`);
    if (rows.length > 1) out.push(pad(rows).replace(/^/gm, "  "));
  }
  return out.join("\n");
}
