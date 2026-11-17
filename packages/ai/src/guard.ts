/**
 * Grounding guard: output must not state facts the model was not given.
 *
 * A model that invents a late fee, a phone number or a link in a message a
 * customer can hold you to is not a quality problem, it is a liability. This
 * finds numbers, email addresses and URLs in the output that appear in none of
 * the inputs. Optional — call it where a made-up fact would matter, and route
 * a hit to a human; do not "fix" the text.
 *
 * Numbers compare by value ("1,200.50" == "1200.5"), so formatting differences
 * pass and changed figures do not: "$840" is NOT an acceptable rendering of
 * 842.50.
 */

export interface UnknownFacts {
  numbers: string[];
  emails: string[];
  urls: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "").toLowerCase();

function facts(text: string) {
  const urls = (text.match(URL_RE) ?? []).map(trimUrl);
  const emails = (text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase());
  // Numbers inside URLs and addresses are part of those, not figures.
  const rest = text.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const numbers = (rest.match(NUMBER_RE) ?? []).map((n) => ({
    raw: n,
    value: Number(n.replace(/,/g, "")),
  }));
  return { urls, emails, numbers };
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
  const knownNumbers = new Set(known.numbers.map((n) => n.value));
  for (const a of allow) if (typeof a === "number") knownNumbers.add(a);
  const knownEmails = new Set(known.emails);
  const knownUrls = new Set(known.urls);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    numbers: uniq(
      out.numbers.filter((n) => !knownNumbers.has(n.value)).map((n) => n.raw),
    ),
    emails: uniq(out.emails.filter((e) => !knownEmails.has(e))),
    urls: uniq(out.urls.filter((u) => !knownUrls.has(u))),
  };
}

export class UngroundedOutputError extends Error {
  constructor(readonly unknown: UnknownFacts) {
    const parts = [
      ...unknown.numbers.map((n) => `number ${n}`),
      ...unknown.emails.map((e) => `email ${e}`),
      ...unknown.urls.map((u) => `url ${u}`),
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
