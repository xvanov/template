import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * The machine-to-machine route handlers: a cron trigger (bearer secret) and an
 * email-provider webhook (HMAC over the raw body). Both must refuse a caller
 * without the secret, and work with it.
 *
 * The secrets are the ones scripts/smoke.sh gives the server; outside the gate,
 * export E2E_CRON_SECRET / E2E_EMAIL_WEBHOOK_SECRET to match your server.
 */
const cronSecret = process.env.E2E_CRON_SECRET;
const webhookSecret = process.env.E2E_EMAIL_WEBHOOK_SECRET;

test("cron: refused without the bearer secret, enqueued with it", async ({
  request,
}) => {
  test.skip(!cronSecret, "E2E_CRON_SECRET not set (scripts/smoke.sh sets it)");

  const url = "/api/cron/nightly-maintenance";
  expect((await request.post(url)).status()).toBe(401);
  expect(
    (
      await request.post(url, { headers: { authorization: "Bearer wrong" } })
    ).status(),
  ).toBe(401);

  const ok = await request.post(url, {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  expect(ok.status()).toBe(202);
  expect(await ok.json()).toMatchObject({ job: "maintenance.nightly" });

  const unknown = await request.post("/api/cron/not-a-schedule", {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  expect(unknown.status()).toBe(404);
});

test("email webhook: verifies the HMAC over the raw body and refuses replays", async ({
  request,
}) => {
  test.skip(
    !webhookSecret,
    "E2E_EMAIL_WEBHOOK_SECRET not set (scripts/smoke.sh sets it)",
  );

  const body = JSON.stringify({
    type: "bounce",
    email: `bounced-${Date.now()}@example.com`,
  });
  const sign = (ts: string, payload: string) =>
    `sha256=${createHmac("sha256", webhookSecret!).update(`${ts}.${payload}`).digest("hex")}`;
  const post = (ts: string, signature: string, data = body) =>
    request.post("/api/webhooks/email-events", {
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": ts,
        "x-webhook-signature": signature,
      },
      data,
    });
  const now = String(Math.floor(Date.now() / 1000));
  const stale = String(Math.floor(Date.now() / 1000) - 3600);

  expect((await post(now, "sha256=deadbeef")).status()).toBe(401);
  expect((await post(now, sign(now, body), body + " ")).status()).toBe(401);
  expect((await post(stale, sign(stale, body))).status()).toBe(401);
  expect((await post(now, sign(now, body))).status()).toBe(200);
});

test("provider webhooks without their secret FAIL CLOSED in the production build", async ({
  request,
}) => {
  // The gate's server runs NODE_ENV=production with no Resend webhook
  // secret: such a call must be refused as a misconfiguration (500), never
  // processed.
  const resend = await request.post("/api/webhooks/email-events", {
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,AAAA",
    },
    data: {
      type: "email.complained",
      data: { email_id: "x", to: ["a@b.test"] },
    },
  });
  expect(resend.status()).toBe(500);
});
