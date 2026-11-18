import { describe, expect, it } from "vitest";

import { verifyAnswer } from "./answer";
import type { SearchHit } from "./search";

const hit = (n: number, content: string): SearchHit => ({
  chunkId: `c${n}`,
  documentId: `d${n}`,
  title: `Doc ${n}`,
  heading: `Doc ${n}`,
  ord: 0,
  content,
  snippet: content,
  snippetParts: [{ text: content, hit: false }],
  score: 1,
  matchedBy: ["keyword"],
});
const hits = [
  hit(1, "The web app listens on port 3200 in development."),
  hit(2, "Backups run nightly and are kept for 14 days."),
];

describe("verifyAnswer", () => {
  it("accepts an answer whose quotes are in the cited sources", () => {
    const r = verifyAnswer(
      {
        known: true,
        answer: "Backups are kept for 14 days.",
        citations: [{ source: 2, quote: "kept for  14 Days" }],
      },
      hits,
      "how long are backups kept?",
    );
    expect(r).toMatchObject({ ok: true, citations: [{ n: 2, chunkId: "c2" }] });
  });

  it.each([
    [{ known: false, answer: "", citations: [] }, "model_unknown"],
    [{ known: true, answer: "Yes.", citations: [] }, "bad_citation"],
    [
      { known: true, answer: "Yes.", citations: [{ source: 3, quote: "x" }] },
      "bad_citation",
    ],
    [
      {
        known: true,
        answer: "Yes.",
        citations: [{ source: 1, quote: "listens on port 8080" }],
      },
      "bad_citation",
    ],
    [
      {
        known: true,
        answer: "Backups are kept for 30 days.",
        citations: [{ source: 2, quote: "kept for 14 days" }],
      },
      "ungrounded",
    ],
  ] as const)("routes %j to a person (%s)", (out, reason) => {
    const r = verifyAnswer(
      { ...out, citations: [...out.citations] },
      hits,
      "q",
    );
    expect(r).toMatchObject({ ok: false, reason });
  });
});

describe("false rejects the checks must not make", () => {
  const src = [
    hit(
      1,
      "Backups run at 02:00 UTC. See [the runbook](https://wiki.example/runbook) for restores.",
    ),
    hit(
      2,
      "Step one: stop the app. Step two: restore the dump. Step three: start the app.",
    ),
  ];
  const ok = (answer: string, citations: { source: number; quote: string }[]) =>
    verifyAnswer({ known: true, answer, citations }, src, "q");

  it("accepts list numbering and [n] markers as structure, not facts", () => {
    expect(
      ok("1. Stop the app [2]\n2. Restore the dump [2]\n3) Start it again", [
        { source: 2, quote: "stop the app" },
      ]),
    ).toMatchObject({ ok: true });
  });

  it("accepts 2:00 for 02:00", () => {
    expect(
      ok("They run at 2:00 UTC.", [{ source: 1, quote: "run at 02:00 UTC" }]),
    ).toMatchObject({ ok: true });
  });

  it("matches a quote against the link text a reader sees", () => {
    expect(
      ok("See the runbook.", [
        { source: 1, quote: "See the runbook for restores" },
      ]),
    ).toMatchObject({ ok: true });
  });

  it("accepts an elided quote whose pieces appear in order, and rejects them out of order", () => {
    expect(
      ok("Stop, restore, start.", [
        { source: 2, quote: "stop the app … start the app" },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      ok("Stop, restore, start.", [
        { source: 2, quote: "start the app... stop the app" },
      ]),
    ).toMatchObject({
      ok: false,
      reason: "bad_citation",
    });
  });

  it("rejects an elided quote made of fragments too short to mean anything", () => {
    expect(
      ok("Stop, restore, start.", [{ source: 2, quote: "Step … the … app" }]),
    ).toMatchObject({ ok: false, reason: "bad_citation" });
    expect(
      ok("Stop, restore, start.", [{ source: 2, quote: "stop the … dump" }]),
    ).toMatchObject({ ok: false, reason: "bad_citation" });
  });

  it("still rejects a real invented figure", () => {
    expect(
      ok("They run at 3:00 UTC.", [{ source: 1, quote: "02:00 UTC" }]),
    ).toMatchObject({
      ok: false,
      reason: "ungrounded",
    });
  });
});
