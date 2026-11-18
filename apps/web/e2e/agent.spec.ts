import { expect, test } from "@playwright/test";

import { signUp, uniqueEmail } from "./helpers";

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
