import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

import { signUp, uniqueEmail } from "./helpers";

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
