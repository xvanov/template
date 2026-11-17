/**
 * The routing rules, pure: no clock, no database, no env. Every rule is a unit
 * test, not a hope.
 *
 * Ported from the production design (personal-assistant's notify/budget.ts and
 * digest.ts). An alert channel that buzzes for everything gets muted, and then
 * it cannot reach you for the one thing that mattered. So:
 *
 *   low     never interrupts: waits for the next digest.
 *   normal  sends while the rolling-24h budget lasts (NOTIFY_PUSH_BUDGET) and
 *           outside quiet hours; otherwise waits for the digest.
 *   high    sends outside quiet hours, budget or not.
 *   urgent  always sends, quiet hours included.
 *
 * "Never the same thing twice" is the dedupe key (index.ts), checked before
 * any of this. The digest goes out at the times you chose (NOTIFY_DIGEST_TIMES)
 * and is not subject to quiet hours or the budget.
 */

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** ntfy's 1 (min) … 5 (max). Low still makes a sound-free entry on the phone. */
export function ntfyPriority(p: Priority): 2 | 3 | 4 | 5 {
  return ({ low: 2, normal: 3, high: 4, urgent: 5 } as const)[p];
}

export interface Decision {
  send: boolean;
  /** Why, for the log and the row's `error` when held. */
  reason: string;
}

/** Minutes since local midnight, start inclusive, end exclusive; may wrap. */
export interface QuietHours {
  from: number;
  to: number;
}

export function route(args: {
  priority: Priority;
  /** Normal-priority sends in the last 24 hours (only read for "normal"). */
  sentLast24h: number;
  budget: number;
  quiet: QuietHours | null;
  now: Date;
  timeZone: string;
}): Decision {
  const { priority } = args;
  if (priority === "low")
    return { send: false, reason: "low priority waits for the digest" };
  if (priority === "urgent") return { send: true, reason: "urgent" };
  if (inQuietHours(args.quiet, args.now, args.timeZone))
    return { send: false, reason: "quiet hours" };
  if (priority === "high") return { send: true, reason: "high" };
  if (args.sentLast24h >= args.budget)
    return {
      send: false,
      reason: `budget of ${args.budget} sends per 24h spent`,
    };
  return { send: true, reason: "within budget" };
}

/** "22-07", "22:30-7" → minutes; blank → null. Malformed → null (env validates). */
export function parseQuietHours(spec: string | undefined): QuietHours | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/.exec(
    (spec ?? "").trim(),
  );
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2] ?? 0);
  const to = Number(m[3]) * 60 + Number(m[4] ?? 0);
  if (from > 1440 || to > 1440 || from === to) return null;
  return { from, to };
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

export function inQuietHours(
  quiet: QuietHours | null,
  now: Date,
  timeZone: string,
): boolean {
  if (!quiet) return false;
  const t = localParts(now, timeZone).minutes;
  return quiet.from < quiet.to
    ? t >= quiet.from && t < quiet.to
    : t >= quiet.from || t < quiet.to;
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
