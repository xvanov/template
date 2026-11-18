import { createHmac } from "node:crypto";

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

test("health endpoint reports every dependency reachable", async ({
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

test("sign up, create an item, and see it persist across a reload", async ({
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

  // The worker round trip: web enqueues on Redis, the SEPARATE worker process
  // picks it up and records the outcome in job_run, and the API reads it back.
  // Only "✓" counts — "✗" means the worker ran the job and it failed, "…" that
  // it never finished. (The gate runs with the LLM off, so this is fast and free.)
  await page
    .getByRole("button", { name: /summarise items in the worker/i })
    .click();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("✓ items.summarize")).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 20_000 });

  // Toggle done, then delete. `click` + an explicit `toBeChecked` rather than
  // `check()`: the list refetches after the mutation, so the control briefly
  // re-renders and check()'s own immediate state assertion races that.
  const toggle = page.getByRole("checkbox", { name: `Toggle "${title}"` });
  await toggle.click();
  await expect(toggle).toBeChecked();

  // Delete goes through a confirm dialog. Escape must cancel it and hand focus
  // back to the trigger (keyboard users would otherwise be lost on the page).
  const deleteButton = page.getByRole("button", { name: `Delete "${title}"` });
  const confirm = page.getByRole("alertdialog", { name: "Delete this item?" });
  await deleteButton.click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(deleteButton).toBeFocused();
  await expect(page.getByText(title)).toBeVisible();

  await deleteButton.click();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});

test("an agent run goes through the worker; with AI off it stops with a clear reason", async ({
  page,
  baseURL,
}) => {
  await signUp(page, uniqueEmail("agent"), baseURL!);

  await page.goto("/app/agent");
  await expect(page.getByText("Nothing waiting for approval")).toBeVisible();

  // The gate runs with the LLM switched off (scripts/smoke.sh), so the run is
  // deterministic: queued by the web app, claimed by the SEPARATE worker
  // process, stopped at its first model call, recorded as failed with why.
  await page.getByLabel("Goal").fill("Find duplicate items");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByTestId("run-status").first()).toHaveText("failed", {
    timeout: 20_000,
  });
  await expect(page.getByText(/AI is not available/).first()).toBeVisible();
});

test("add a document, the worker indexes it, and keyword search finds it (AI off)", async ({
  page,
  baseURL,
}) => {
  await signUp(page, uniqueEmail("docs"), baseURL!);
  await page.goto("/app/docs");
  await expect(page.getByText("No documents yet")).toBeVisible();

  await page.getByLabel("Title").fill("Runbook");
  await page
    .getByLabel("Text")
    .fill(
      "# Backups\n\nThe nightly backup runs at 02:00 UTC.\n\n# Ports\n\nThe web app listens on 3200.",
    );
  await page.getByRole("button", { name: "Add document" }).click();

  // The docs.ingest job runs in the real worker; the list polls until ready.
  await expect(page.getByTestId("doc-status")).toHaveText("2 sections", {
    timeout: 30_000,
  });

  await page.getByLabel("Search documents").fill("when does the backup run");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.getByText("Runbook › Backups")).toBeVisible();
  await expect(results.locator("mark").first()).toHaveText(/backup/i);
  await expect(
    page.getByText("Keyword search only (embeddings are off)."),
  ).toBeVisible();
});

test("signing out revokes access to the app", async ({ page, baseURL }) => {
  await signUp(page, uniqueEmail("signout"), baseURL!);

  // Sign out lives in the account menu (header, top right) on every viewport.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

  // The guard is server-side, so asking for /app directly must also bounce.
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("an anonymous visitor cannot reach the app", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("an unconfirmed account cannot sign in", async ({ page }) => {
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
    // The list has loaded, so the page has hydrated: text typed before that
    // is wiped by React taking over the input (a flake under parallel load).
    await expect(pageA.getByText(/nothing yet/i)).toBeVisible();
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

test("inbound email: a signed webhook lands in the workspace inbox, via the worker", async ({
  page,
  baseURL,
  request,
}) => {
  const secret = process.env.E2E_EMAIL_WEBHOOK_SECRET;
  test.skip(
    !secret,
    "E2E_EMAIL_WEBHOOK_SECRET not set (scripts/smoke.sh sets it)",
  );

  await signUp(page, uniqueEmail("inbound"), baseURL!);
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Create an inbound address" }).click();
  const address = (
    await page.getByTestId("inbound-address").textContent()
  )?.trim();
  expect(address).toMatch(/@/);

  // What a mail provider (or MTA) would POST: signed over the raw body.
  const subject = `Order question ${Date.now()}`;
  const body = JSON.stringify({
    id: `e2e-${Date.now()}-${Math.random()}`,
    from: "Jane Customer <jane@customer.example>",
    to: [address],
    subject,
    html: "<p>Where is my order?</p><script>window.pwned = true</script>",
    attachments: [
      {
        filename: "notes.txt",
        contentType: "text/plain",
        content: Buffer.from("order 42").toString("base64"),
      },
    ],
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await request.post("/api/webhooks/email-inbound", {
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `sha256=${createHmac("sha256", secret!).update(`${ts}.${body}`).digest("hex")}`,
    },
    data: body,
  });
  expect(await res.json()).toMatchObject({ routed: true });

  // The worker turns it into a readable message: text from the HTML (never
  // the HTML itself), the attachment in storage behind an authenticated link.
  const message = page.getByRole("button", { name: new RegExp(subject) });
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(message).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await message.click();
  await expect(page.getByTestId("inbound-text")).toHaveText(
    "Where is my order?",
    { timeout: 20_000 },
  );
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  const attachment = page.getByRole("link", { name: "notes.txt" });
  // page.request carries the signed-in session; the blob route requires it.
  const file = await page.request.get((await attachment.getAttribute("href"))!);
  expect(await file.text()).toBe("order 42");

  await page.getByRole("button", { name: "Mark handled" }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
});
