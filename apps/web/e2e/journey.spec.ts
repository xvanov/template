import { expect, test } from "@playwright/test";

import { waitForVerificationLink } from "./mailpit";

/**
 * The core user journey, driven against the real app.
 *
 * This is the merge gate: unit tests can pass on an application that does not
 * boot, so nothing ships until this has signed up a real user, confirmed the
 * address through an email that actually went over SMTP, written to the real
 * database and read the row back through the real API.
 *
 * Each test signs up its own account so the suite can run in parallel and
 * repeatedly against the same database without a reset step.
 */
const password = "testpassword123";

function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** Fill and submit the sign-up form. Leaves you on the "confirm" screen. */
async function submitSignUp(
  page: import("@playwright/test").Page,
  email: string,
) {
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
async function signUp(
  page: import("@playwright/test").Page,
  email: string,
  baseURL: string,
) {
  await submitSignUp(page, email);
  await expect(page.getByTestId("verify-sent")).toBeVisible({
    timeout: 20_000,
  });

  const link = await waitForVerificationLink(email, baseURL);
  await page.goto(link);
  await expect(page).toHaveURL(/\/app$/, { timeout: 20_000 });
}

test("@smoke health endpoint reports every dependency reachable", async ({
  request,
}) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    checks: Record<string, { ok: boolean }>;
  };
  expect(body.ok).toBe(true);
  expect(body.checks.database?.ok).toBe(true);
  expect(body.checks.redis?.ok).toBe(true);
});

test("@smoke sign up, create an item, and see it persist across a reload", async ({
  page,
  baseURL,
}) => {
  const email = uniqueEmail("journey");
  await signUp(page, email, baseURL!);

  // A brand-new account gets its own workspace, so the list starts empty.
  await expect(page.getByText(/nothing yet/i)).toBeVisible();

  const title = `ship it ${Date.now()}`;
  await page.getByLabel("New item title").fill(title);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(title)).toBeVisible();

  // Reload: proves the row is in Postgres, not just in React state.
  await page.reload();
  await expect(page.getByText(title)).toBeVisible();

  // Toggle done, then delete. `click` + an explicit `toBeChecked` rather than
  // `check()`: the list refetches after the mutation, so the control briefly
  // re-renders and check()'s own immediate state assertion races that.
  const toggle = page.getByRole("checkbox", { name: `Toggle "${title}"` });
  await toggle.click();
  await expect(toggle).toBeChecked();

  await page.getByRole("button", { name: `Delete "${title}"` }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});

test("@smoke signing out revokes access to the app", async ({
  page,
  baseURL,
}) => {
  await signUp(page, uniqueEmail("signout"), baseURL!);

  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

  // The guard is server-side, so asking for /app directly must also bounce.
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("an anonymous visitor cannot reach the app", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("@smoke an unconfirmed account cannot sign in", async ({ page }) => {
  const email = uniqueEmail("unconfirmed");

  // Sign up, but deliberately never open the emailed link.
  await submitSignUp(page, email);
  await expect(page.getByTestId("verify-sent")).toBeVisible({
    timeout: 20_000,
  });

  // The account exists, the password is right — and it must still be refused.
  // This is the whole point of requiring confirmation: without it, anyone can
  // register an address they do not control and use it.
  await page.goto("/login");
  await expect(page.locator("form[data-hydrated='true']")).toBeAttached();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // Match the text, not role=alert: Next's route announcer is also role=alert,
  // which makes that selector ambiguous.
  await expect(page.getByText(/email not verified/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("one tenant's items are invisible to another", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const pageA = await first.newPage();
    const pageB = await second.newPage();

    await signUp(pageA, uniqueEmail("tenant-a"), baseURL!);
    const secret = `tenant-a-secret-${Date.now()}`;
    await pageA.getByLabel("New item title").fill(secret);
    await pageA.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pageA.getByText(secret)).toBeVisible();

    await signUp(pageB, uniqueEmail("tenant-b"), baseURL!);
    await expect(pageB.getByText(secret)).toHaveCount(0);
    await expect(pageB.getByText(/nothing yet/i)).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});
