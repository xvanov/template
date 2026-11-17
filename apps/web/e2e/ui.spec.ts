import { expect, test } from "@playwright/test";

/**
 * App-wide UI promises: the theme follows the OS with no flash and can be
 * toggled, and the app is installable (manifest + touch icon). Uses /login,
 * which every app keeps; the /design styleguide has its own spec.
 */

test("dark mode follows the OS before hydration and toggles", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const html = page.locator("html");

  // "No flash" = the class is set by next-themes' inline script during HTML
  // parsing, not by React after hydration. Prove it by blocking every JS chunk
  // so React never hydrates: the class must still be there.
  await page.route("**/_next/static/chunks/**", (route) => route.abort());
  await page.goto("/login");
  await expect(html).toHaveClass(/\bdark\b/);
  await page.unrouteAll();

  await page.goto("/login");
  await expect(page.locator("form[data-hydrated='true']")).toBeAttached();
  const toggle = page.getByRole("button", { name: "Toggle dark mode" });

  // Flip to light: pinned, so it survives a reload against a dark OS.
  await toggle.click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).not.toHaveClass(/\bdark\b/);

  // Flip back: returns to following the OS ("system"), not a pinned dark.
  await expect(page.locator("form[data-hydrated='true']")).toBeAttached();
  await toggle.click();
  await expect(html).toHaveClass(/\bdark\b/);
  expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(
    "system",
  );
});

test("the app is installable: manifest and touch icon", async ({
  page,
  request,
}) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { start_url: string; display: string };
  expect(body.start_url).toBe("/app");
  expect(body.display).toBe("standalone");

  await page.goto("/login");
  const touch = page.locator('link[rel="apple-touch-icon"]');
  await expect(touch).toHaveCount(1);
  const icon = await request.get((await touch.getAttribute("href"))!);
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toBe("image/png");
});
