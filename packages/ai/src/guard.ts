/**
 * Grounding guard: output must not state facts the model was not given.
 *
 * A model that invents a late fee, a phone number or a link in a message a
 * customer can hold you to is not a quality problem, it is a liability. This
 * finds numbers, email addresses and links in the output that appear in none
 * of the inputs. Optional — call it where a made-up fact would matter, and
 * route a hit to a human; do not "fix" the text.
 *
 * How things compare:
 *  - Numbers are whole TOKENS, separators included. A plain number compares
 *    by value ("1,200.50" == "1200.5"; "$840" is NOT 842.50; "-5" is not
 *    "5"). Anything with other separators — phone numbers, dates, times,
 *    ranges ("555-1234", "2026-12-01", "10:30", "5-10") — must appear as the
 *    same token: "555-1234" does not pass because 555 and 1234 appear apart.
 *  - Links: http(s) URLs and bare domains (`evil.com/pay`, `www.x.com`),
 *    compared without scheme, `www.`, case or trailing "/" and punctuation.
 *  - Emails: case-insensitive.
 *
 * Known limits (it is a tripwire, not a parser): it does not equate a
 * percentage with its decimal (15% vs 0.15), words with digits ("five" vs 5),
 * or locale formats ("1.200,50" is read as two tokens' worth of US format);
 * bare domains are matched on a list of common TLDs, so `foo.zz` is missed.
 * Pass legitimately derived values (a total you computed) in `allow`.
 */

export interface UnknownFacts {
  numbers: string[];
  emails: string[];
  urls: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;
const TLDS =
  "com|net|org|io|co|dev|app|ai|info|biz|me|us|uk|de|fr|eu|ca|au|nl|es|it|ch|se|no|jp|in|br|xyz|link|ly|gg|tv|to|sh|cc|site|online|shop|store|pay|test|example";
const DOMAIN_RE = new RegExp(
  `\\b(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})\\b(?:/[^\\s<>"')\\]]*)?`,
  "gi",
);
// A run of digits with internal separators (the regex consumes "3-5" or
// "10:30" whole). A leading minus counts only when not glued to a word
// ("x-5" is 5), and digits glued to letters ("v2", "abc123") are not figures.
const NUMBER_RE = /(?:(?<!\w)-)?(?<![A-Za-z_])\d(?:[\d,.\-/:]*\d)?/g;
const PLAIN_NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

const normLink = (u: string) =>
  u
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, "");

/** A number token's comparison key: its value when plain, else itself. */
const numKey = (t: string) =>
  PLAIN_NUMBER.test(t) ? `n:${Number(t.replace(/,/g, ""))}` : `t:${t}`;

function facts(text: string) {
  const urls = (text.match(URL_RE) ?? []).map(normLink);
  const emails = (text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase());
  // Emails and URLs first, so their parts are not read as domains or figures.
  const noUrls = text.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const domains = (noUrls.match(DOMAIN_RE) ?? []).map(normLink);
  const rest = noUrls.replace(DOMAIN_RE, " ");
  const numbers = (rest.match(NUMBER_RE) ?? [])
    // Trailing sentence punctuation is not part of the figure.
    .map((n) => n.replace(/[.,:]+$/, ""))
    .map((raw) => ({ raw, key: numKey(raw) }));
  return { links: [...urls, ...domains], emails, numbers };
}

/**
 * Facts in `output` absent from every input. `allow` adds values the model may
 * legitimately produce (e.g. a computed total you checked yourself).
 */
export function unknownFactsIn(
  output: unknown,
  inputs: unknown[],
  allow: (string | number)[] = [],
): UnknownFacts {
  const out = facts(textOf(output));
  const known = facts([...inputs, ...allow].map(textOf).join("\n"));
  const knownNumbers = new Set(known.numbers.map((n) => n.key));
  for (const a of allow) if (typeof a === "number") knownNumbers.add(`n:${a}`);
  const knownEmails = new Set(known.emails);
  const knownLinks = new Set(known.links);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    numbers: uniq(
      out.numbers.filter((n) => !knownNumbers.has(n.key)).map((n) => n.raw),
    ),
    emails: uniq(out.emails.filter((e) => !knownEmails.has(e))),
    urls: uniq(out.links.filter((u) => !knownLinks.has(u))),
  };
}

export class UngroundedOutputError extends Error {
  constructor(readonly unknown: UnknownFacts) {
    const parts = [
      ...unknown.numbers.map((n) => `number ${n}`),
      ...unknown.emails.map((e) => `email ${e}`),
      ...unknown.urls.map((u) => `link ${u}`),
    ];
    super(`Output states facts not in the input: ${parts.join(", ")}`);
    this.name = "UngroundedOutputError";
  }
}

/** Throws UngroundedOutputError if the output names any fact absent from the inputs. */
export function assertGrounded(
  output: unknown,
  inputs: unknown[],
  allow: (string | number)[] = [],
): void {
  const u = unknownFactsIn(output, inputs, allow);
  if (u.numbers.length || u.emails.length || u.urls.length) {
    throw new UngroundedOutputError(u);
  }
}
