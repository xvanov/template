/**
 * The rules that need no I/O: priorities, digest slots, the digest's text.
 * Kept pure so each is a unit test.
 *
 * Priorities: `low` never interrupts (it waits for the next digest); `normal`,
 * `high` and `urgent` are sent at once and differ only in how loudly the phone
 * announces them (ntfy priority 3/4/5). "Never the same thing twice" is the
 * dedupe key (index.ts).
 *
 * Deliberately NOT ported from personal-assistant: quiet hours and a daily
 * push budget. With a handful of deduped operator alerts they cost three env
 * vars and their own tests for little; add them back when alert volume does.
 */

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** ntfy's 1 (min) … 5 (max). */
export function ntfyPriority(p: Priority): 2 | 3 | 4 | 5 {
  return ({ low: 2, normal: 3, high: 4, urgent: 5 } as const)[p];
}

/** The local calendar date and minute-of-day of `now` in `timeZone`. */
export function localParts(
  now: Date,
  timeZone: string,
): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** "17:00, 9" → [540, 1020]: sorted, deduplicated minutes. */
export function parseDigestTimes(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(part.trim());
    if (m && Number(m[1]) < 24 && Number(m[2] ?? 0) < 60) {
      out.add(Number(m[1]) * 60 + Number(m[2] ?? 0));
    }
  }
  return [...out].sort((a, b) => a - b);
}

const pad = (n: number) => String(n).padStart(2, "0");
const label = (date: string, minutes: number) =>
  `${date} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** The calendar day before "YYYY-MM-DD". */
function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * The digest slot to run now, or null. Only the LATEST slot at or before `now`
 * (local time) is a candidate, and only if it is newer than the last one run:
 * a worker that was down over three slots sends one digest when it is back,
 * never a backlog. Labels are local "YYYY-MM-DD HH:MM", which sort as text.
 */
export function dueSlot(args: {
  times: number[];
  now: Date;
  timeZone: string;
  lastSlot?: string | null;
}): string | null {
  if (!args.times.length) return null;
  const { date, minutes } = localParts(args.now, args.timeZone);
  const today = args.times.filter((t) => t <= minutes);
  const slot = today.length
    ? label(date, today.at(-1)!)
    : label(dayBefore(date), args.times.at(-1)!);
  return args.lastSlot && args.lastSlot >= slot ? null : slot;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const LIST_MAX = 25;

/** The digest's text: one line per held notification, most urgent first. */
export function renderDigest(
  held: { priority: string; title: string; body: string; createdAt: Date }[],
  slot: string,
): { title: string; body: string } {
  const rank = (p: string) => PRIORITIES.indexOf(p as Priority);
  const sorted = [...held].sort(
    (a, b) =>
      rank(b.priority) - rank(a.priority) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const lines = sorted.slice(0, LIST_MAX).map((n) => {
    const first = n.body.split("\n").find((l) => l.trim()) ?? "";
    const tag = n.priority === "low" ? "" : `[${n.priority}] `;
    return `- ${tag}${clip(n.title, 120)}${first ? ` — ${clip(first, 100)}` : ""}`;
  });
  if (sorted.length > LIST_MAX)
    lines.push(
      `- …and ${sorted.length - LIST_MAX} more (notification table, status "digested")`,
    );
  const n = held.length;
  return {
    title: `Digest ${slot.slice(11)}: ${n} notification${n === 1 ? "" : "s"}`,
    body: lines.join("\n"),
  };
}
