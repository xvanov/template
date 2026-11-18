/**
 * Small pure helpers for inbound content. No I/O, unit-tested.
 */

/**
 * HTML → readable plain text, for mail that came without a text part. Not a
 * sanitiser: the result is shown as TEXT (React escapes it); the HTML itself is
 * never rendered by the app.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : "";
}

/** Every `<...>` message id in In-Reply-To / References header values. */
export function messageIds(
  ...values: (string | readonly string[] | null | undefined)[]
): string[] {
  const out = new Set<string>();
  for (const v of values.flat()) {
    if (!v) continue;
    for (const m of v.matchAll(/<[^<>\s]+>/g)) out.add(m[0]);
  }
  return [...out];
}

/**
 * The outbound_message row ids in our own Message-IDs (`<obm.<id>@domain>`,
 * set by packages/email on every message it sends).
 */
export function outboundIdsIn(ids: readonly string[]): string[] {
  return ids
    .map((id) => /^<obm\.([a-z0-9]{10,40})@/i.exec(id)?.[1])
    .filter((x): x is string => Boolean(x));
}

/** Keep a filename to something safe to show and store. */
export function cleanFilename(name: string | null | undefined): string {
  const base = (name ?? "")
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return base || "attachment";
}
