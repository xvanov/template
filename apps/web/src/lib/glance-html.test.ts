import { describe, expect, it } from "vitest";

import { ago, escapeHtml, renderGlancePage } from "./glance-html";

const now = new Date("2026-11-18T12:00:00Z");
const snapshot = {
  at: now.toISOString(),
  details: true,
  approvals: {
    count: 7,
    rows: [
      {
        id: "p1",
        title: `<img src=x onerror=alert(1)>`,
        detail: null,
        at: "2026-11-18T11:55:00Z",
      },
    ],
  },
  inbox: { unhandled: 0, rows: [] },
};

describe("renderGlancePage", () => {
  const html = renderGlancePage({
    snapshot,
    appName: "Acme",
    nonce: "n0nce",
    now,
  });

  it("escapes every value from the database", () => {
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("is one small self-contained document for the glasses", () => {
    // The Display web-app startup budget is 300 KB; stay a tiny fraction.
    expect(Buffer.byteLength(html)).toBeLessThan(8_000);
    expect(html).not.toMatch(/<(link|img|iframe)\b|src="http/);
    expect(html).toContain('<script nonce="n0nce">');
    // Black is transparent on the additive display.
    expect(html).toContain("background:#000");
    expect(html).toContain('name="viewport" content="width=device-width');
  });

  it("shows counts, empty states and relative times", () => {
    expect(html).toContain('<span class="n">7</span>');
    expect(html).toContain('<span class="n zero">0</span>');
    expect(html).toContain("Inbox is clear.");
    expect(html).toContain('<span class="a">5m</span>');
  });
});

describe("helpers", () => {
  it("ago() is coarse", () => {
    expect(ago("2026-11-18T11:59:30Z", now)).toBe("now");
    expect(ago("2026-11-18T09:00:00Z", now)).toBe("3h");
    expect(ago("2026-11-15T12:00:00Z", now)).toBe("3d");
  });
  it("escapeHtml covers attributes too", () => {
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
});

describe("counts-only links", () => {
  it("show numbers and no rows", () => {
    const html = renderGlancePage({
      snapshot: {
        ...snapshot,
        details: false,
        approvals: { count: 2, rows: [] },
      },
      appName: "Acme",
      nonce: "n",
      now,
    });
    expect(html).toContain(
      "2 waiting for your approval. Details on your phone.",
    );
    expect(html).toContain("Inbox is clear.");
    expect(html).not.toContain("<li");
  });
});
