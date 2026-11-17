import { expect, test } from "@playwright/test";

/** The /design styleguide. Delete this file together with src/app/design. */
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
