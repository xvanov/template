import { expect, test } from "@playwright/test";

import { signUp, uniqueEmail } from "./helpers";

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
