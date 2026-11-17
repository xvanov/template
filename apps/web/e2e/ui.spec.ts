import { expect, test } from "@playwright/test";

/**
 * The UI kit's own promises: the styleguide renders without auth and is kept
 * out of search engines, the theme follows the OS with no flash and can be
 * toggled, and the web app manifest is served.
 */

test("the /design styleguide is public, static and noindex", async ({
  page,
}) => {
  const res = await page.goto("/design");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/design$/);
  await expect(
    page.getByRole("heading", { name: "Components", level: 1 }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/,
  );
});

test("dark mode follows the OS before hydration and toggles", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });

  // "No flash" = the class is set by next-themes' inline script during HTML
  // parsing, not by React after hydration. Prove it by blocking every JS chunk
  // so React never hydrates: the class must still be there.
  await page.route("**/_next/static/chunks/**", (route) => route.abort());
  await page.goto("/design");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.unrouteAll();

  // With JS, the toggle pins the opposite theme and it survives a reload.
  await page.goto("/design");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  // A static page has no hydration marker to wait on, so retry the click
  // until React has attached the handler (clicking only while still dark).
  const html = page.locator("html");
  await expect(async () => {
    if (/\bdark\b/.test((await html.getAttribute("class")) ?? "")) {
      await page.getByRole("button", { name: "Toggle dark mode" }).click();
    }
    await expect(html).not.toHaveClass(/\bdark\b/, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
});

test("a dialog traps focus and closes on Escape", async ({ page }) => {
  await page.goto("/design");
  const trigger = page.getByRole("button", { name: "Open dialog" });
  const dialog = page.getByRole("dialog", { name: "Edit workspace" });
  await expect(async () => {
    if (!(await dialog.isVisible())) await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the web app manifest is served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { start_url: string; display: string };
  expect(body.start_url).toBe("/app");
  expect(body.display).toBe("standalone");
});
