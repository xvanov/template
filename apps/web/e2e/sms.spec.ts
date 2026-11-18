import { expect, test } from "@playwright/test";

test("Twilio webhooks without their token FAIL CLOSED in the production build", async ({
  request,
}) => {
  // The gate's server runs NODE_ENV=production with no Twilio token: every
  // call must be refused as a misconfiguration (500), never processed. Also
  // proves the Twilio routes load in the standalone bundle.
  const stop = await request.post("/api/webhooks/twilio", {
    form: {
      MessageSid: "SM1",
      From: "+447700900123",
      To: "+15550100000",
      Body: "STOP",
    },
  });
  expect(stop.status()).toBe(500);
  const status = await request.post("/api/webhooks/twilio/status", {
    form: { MessageSid: "SM1", MessageStatus: "delivered" },
  });
  expect(status.status()).toBe(500);
});
