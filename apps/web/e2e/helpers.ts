/**
 * Shared by the e2e specs: sign-up through the real form and the emailed
 * confirmation link.
 */
import { expect, type Page } from "@playwright/test";

import { waitForVerificationLink } from "./mailpit";

export const password = "testpassword123";

export function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** Fill and submit the sign-up form. Leaves you on the "confirm" screen. */
export async function submitSignUp(page: Page, email: string) {
  // The mode is in the URL, so no click is needed to reach the sign-up form.
  await page.goto("/login?mode=signup");

  // Wait for React to attach its handlers. Filling and submitting before
  // hydration is the single most common source of flaky auth tests.
  await expect(page.locator("form[data-hydrated='true']")).toBeAttached();

  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
}

/**
 * The whole sign-up: form, then the emailed confirmation link, which both
 * verifies the address and signs the user in.
 */
export async function signUp(page: Page, email: string, baseURL: string) {
  await submitSignUp(page, email);
  await expect(page.getByTestId("verify-sent")).toBeVisible({
    timeout: 20_000,
  });

  const link = await waitForVerificationLink(email, baseURL);
  await page.goto(link);
  await expect(page).toHaveURL(/\/app$/, { timeout: 20_000 });
}
