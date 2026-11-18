import { expect, test } from "@playwright/test";

/**
 * The glance page for Meta Ray-Ban Display glasses, in the production build:
 * an unknown link is a plain 404 page that keeps the URL's secret out of
 * caches and referrers, and ships no framework JavaScript. (A valid link is
 * covered against real Postgres in src/app/glance/[token]/glance.int.test.ts.)
 */
test("an unknown glance link is a small, uncached 404", async ({ request }) => {
  const res = await request.get(`/glance/gl_${"A".repeat(43)}`);
  expect(res.status()).toBe(404);
  const h = res.headers();
  expect(h["cache-control"]).toBe("no-store");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["content-security-policy"]).toContain("default-src 'none'");
  const html = await res.text();
  expect(html).toContain("This glance link is not valid");
  expect(html).not.toContain("/_next/");
  expect(Buffer.byteLength(html)).toBeLessThan(4_000);
});
