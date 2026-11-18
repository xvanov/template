import { describe, expect, it } from "vitest";

import {
  chunkText,
  CHUNKER_VERSION,
  documentHash,
  embedInput,
  MAX_CHARS,
  SEP,
} from "./chunk";

const para = (n: number, word = "lorem") =>
  Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ") + ".";

describe("chunkText", () => {
  it("gives every chunk its heading path, title first", () => {
    const md = [
      "Intro line.",
      "# Setup",
      "Install it.",
      "## Ports",
      "Web runs on 3200.",
      "# Backups",
      "Nightly at 02:00.",
    ].join("\n");
    const chunks = chunkText("Guide", md);
    expect(chunks.map((c) => [c.heading, c.content])).toEqual([
      ["Guide", "Intro line."],
      [`Guide${SEP}Setup`, "Install it."],
      [`Guide${SEP}Setup${SEP}Ports`, "Web runs on 3200."],
      [`Guide${SEP}Backups`, "Nightly at 02:00."],
    ]);
    expect(chunks.map((c) => c.ord)).toEqual([0, 1, 2, 3]);
  });

  it("does not read # inside a code fence as a heading, and keeps the fence whole", () => {
    const md =
      "# Run\n\n```bash\n# not a heading\nmake dev\n\nmake test\n```\n";
    const chunks = chunkText("T", md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe(`T${SEP}Run`);
    expect(chunks[0]!.content).toContain(
      "# not a heading\nmake dev\n\nmake test",
    );
  });

  it("emits nothing for a heading with no body", () => {
    expect(chunkText("T", "# A\n## B\ntext").map((c) => c.heading)).toEqual([
      `T${SEP}A${SEP}B`,
    ]);
  });

  it("packs paragraphs up to the size limit, with overlap between chunks", () => {
    const text = Array.from({ length: 12 }, (_, i) => para(30, `p${i}w`)).join(
      "\n\n",
    );
    const chunks = chunkText("T", text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks)
      expect(c.content.length).toBeLessThanOrEqual(MAX_CHARS);
    // Overlap: each chunk after the first starts with text from the previous one.
    for (let i = 1; i < chunks.length; i++) {
      const head = chunks[i]!.content.slice(0, 20);
      expect(chunks[i - 1]!.content).toContain(head);
    }
    // Nothing lost: every word of the input is in some chunk.
    const all = chunks.map((c) => c.content).join(" ");
    for (const w of text.match(/p\d+w\d+/g)!) expect(all).toContain(w);
  });

  it("splits a paragraph longer than the limit at word boundaries", () => {
    const long = para(600);
    const chunks = chunkText("T", long, { maxChars: 500, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(500);
      expect(c.content).toMatch(/^lorem\d+/);
    }
  });

  it("is deterministic, and hashes change only with the chunk", () => {
    const a = chunkText("T", "# A\none\n# B\ntwo");
    const b = chunkText("T", "# A\none\n# B\ntwo changed");
    expect(chunkText("T", "# A\none\n# B\ntwo")).toEqual(a);
    expect(b[0]!.contentHash).toBe(a[0]!.contentHash);
    expect(b[1]!.contentHash).not.toBe(a[1]!.contentHash);
  });

  it("handles CRLF and empty input", () => {
    expect(chunkText("T", "")).toEqual([]);
    expect(chunkText("T", "# A\r\nbody\r\n")[0]!.content).toBe("body");
  });
});

describe("hashes and embed input", () => {
  it("documentHash covers title, text and the chunker version", () => {
    expect(documentHash("a", "x")).not.toBe(documentHash("b", "x"));
    expect(documentHash("a", "x")).not.toBe(documentHash("a", "y"));
    expect(CHUNKER_VERSION).toBeGreaterThan(0);
  });

  it("embeds the heading path with the text", () => {
    expect(embedInput({ heading: "G › Ports", content: "3200" })).toBe(
      "G › Ports\n\n3200",
    );
  });
});
