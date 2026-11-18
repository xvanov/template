/**
 * Split a document into retrievable chunks.
 *
 * Markdown-aware where it is cheap: ATX headings (`#`..`######`, outside code
 * fences) start a new section, and every chunk carries its heading path
 * ("Deploy guide › Database › Backups") — the document title is the root.
 * That path is embedded with the chunk and indexed as the FTS heading (weight
 * A), the single cheapest retrieval win: a chunk that says "run it nightly"
 * is findable by "backup schedule" because its heading says "Backups".
 *
 * Inside a section: paragraphs (blank-line separated; a code fence is one
 * paragraph) are packed up to MAX_CHARS, and the next chunk starts with up to
 * OVERLAP_CHARS from the end of the previous one, cut at a sentence or word
 * boundary, so a fact straddling the cut is whole in at least one chunk.
 * A paragraph longer than MAX_CHARS is cut at sentence, then word, then hard
 * boundaries. Plain text is the same thing with no headings.
 *
 * Sizes (~1200 chars ≈ 300 tokens, 150 overlap) are the ones that held up in
 * the personal-assistant search evals; docrag used 3200/400 for dense legal
 * text where a whole clause must stay together. Changing them, or anything
 * else here, changes CHUNKER_VERSION, which changes every document's
 * contentHash, so the next ingest rebuilds instead of skipping.
 */
import { createHash } from "node:crypto";

export const CHUNKER_VERSION = 1;
export const MAX_CHARS = 1200;
export const OVERLAP_CHARS = 150;

export interface Chunk {
  ord: number;
  /** Heading path, title first: "Guide › Setup › Ports". */
  heading: string;
  content: string;
  /** sha256(heading + content): an unchanged chunk keeps its embedding. */
  contentHash: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  /** Treat `#` lines as headings. Default: on (harmless for plain text). */
  markdown?: boolean;
}

export const SEP = " › ";

export function sha256(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\u0000");
  return h.digest("hex");
}

/** What a document's ingest compares: its text AND how it would be chunked. */
export function documentHash(title: string, content: string): string {
  return sha256(`chunker:v${CHUNKER_VERSION}`, title, content);
}

/** What gets embedded: the heading path gives the chunk its context. */
export function embedInput(c: Pick<Chunk, "heading" | "content">): string {
  return c.heading ? `${c.heading}\n\n${c.content}` : c.content;
}

interface Section {
  path: string[];
  body: string[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function sections(text: string, markdown: boolean): Section[] {
  const out: Section[] = [{ path: [], body: [] }];
  const stack: { level: number; title: string }[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1] === fence) fence = null;
    }
    const h = markdown && fence === null && !f ? HEADING.exec(line) : null;
    if (h) {
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level)
        stack.pop();
      stack.push({ level, title: h[2]!.trim() });
      out.push({ path: stack.map((s) => s.title), body: [] });
    } else {
      out[out.length - 1]!.body.push(line);
    }
  }
  return out;
}

/** Blank-line separated blocks; a fenced code block stays one block. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const p = cur.join("\n").trim();
    if (p) out.push(p);
    cur = [];
  };
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1] === fence) fence = null;
    }
    if (fence === null && !f && line.trim() === "") flush();
    else cur.push(line);
  }
  flush();
  return out;
}

/** Cut `text` into pieces ≤ max, preferring sentence, then word boundaries. */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
      window.lastIndexOf("\n"),
    );
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.3) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trimStart();
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** The last ≤ n chars of `text`, starting at a sentence or word boundary. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? "" : text;
  const window = text.slice(-n);
  const sentence = window.search(/[.!?]\s+\S/);
  if (sentence >= 0) return window.slice(sentence + 1).trim();
  const space = window.indexOf(" ");
  return space >= 0 ? window.slice(space + 1).trim() : window.trim();
}

export function chunkText(
  title: string,
  text: string,
  opts: ChunkOptions = {},
): Chunk[] {
  const max = opts.maxChars ?? MAX_CHARS;
  const overlap = Math.min(opts.overlapChars ?? OVERLAP_CHARS, max / 2);
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const chunks: Omit<Chunk, "ord">[] = [];

  for (const section of sections(normalized, opts.markdown ?? true)) {
    const heading = [title.trim(), ...section.path].filter(Boolean).join(SEP);
    const blocks = paragraphs(section.body).flatMap((p) =>
      p.length > max ? hardSplit(p, max) : [p],
    );
    let cur = "";
    let fresh = false; // cur holds text not yet emitted (not only overlap)
    const emit = () => {
      if (fresh && cur.trim()) {
        chunks.push({
          heading,
          content: cur.trim(),
          contentHash: sha256(heading, cur.trim()),
        });
      }
      cur = tail(cur, overlap);
      fresh = false;
    };
    for (const block of blocks) {
      const joined = cur ? `${cur}\n\n${block}` : block;
      if (joined.length > max && fresh) {
        emit();
        cur =
          cur && cur.length + block.length + 2 <= max
            ? `${cur}\n\n${block}`
            : block;
      } else {
        cur = joined.length > max ? block : joined;
      }
      fresh = true;
    }
    emit();
  }
  return chunks.map((c, ord) => ({ ...c, ord }));
}
