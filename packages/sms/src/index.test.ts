/**
 * SMS without a network: Twilio's SDK is faked, signatures are checked
 * against Twilio's documented example.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@repo/env";

import {
  deliveryStatusOf,
  explainTwilioError,
  smsKeyword,
  statusCallbackUrl,
  useFakeTwilio,
  verifyTwilioWebhook,
  type FakeTwilio,
} from "./index";
import { transmit } from "./transport";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_WEBHOOK_BASE_URL",
  "NODE_ENV",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  Object.assign(process.env, vars);
  resetEnvCache();
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  useFakeTwilio(undefined);
  resetEnvCache();
});

describe("verifyTwilioWebhook", () => {
  // Twilio's worked example ("Validating requests", security docs): auth
  // token 12345, this URL and these params sign to 0/KCTR6DLpKmkAf8muzZqo1nDgQ=.
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };
  const documented = {
    pathAndQuery: "/myapp.php?foo=1&bar=2",
    params,
    signature: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
  };

  it("accepts Twilio's documented example against the PUBLIC base URL", () => {
    setEnv({
      TWILIO_AUTH_TOKEN: "12345",
      TWILIO_WEBHOOK_BASE_URL: "https://mycompany.com/",
    });
    expect(verifyTwilioWebhook(documented)).toEqual({ ok: true });
  });

  it("refuses a changed param, a missing signature, or the wrong origin", () => {
    setEnv({
      TWILIO_AUTH_TOKEN: "12345",
      TWILIO_WEBHOOK_BASE_URL: "https://mycompany.com",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      verifyTwilioWebhook({
        ...documented,
        params: { ...params, Digits: "9999" },
      }),
    ).toMatchObject({ status: 401 });
    expect(
      verifyTwilioWebhook({ ...documented, signature: null }),
    ).toMatchObject({ status: 401 });
    // What a container behind a proxy would see if it trusted req.url.
    setEnv({ TWILIO_WEBHOOK_BASE_URL: "http://10.0.0.5:3000" });
    expect(verifyTwilioWebhook(documented)).toMatchObject({ status: 401 });
    warn.mockRestore();
  });

  it("FAILS CLOSED in production without TWILIO_AUTH_TOKEN; open in development", () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    setEnv({ NODE_ENV: "production" });
    expect(verifyTwilioWebhook(documented)).toMatchObject({ status: 500 });
    setEnv({ NODE_ENV: "development" });
    expect(verifyTwilioWebhook(documented)).toEqual({ ok: true });
  });
});

describe("transport (faked SDK)", () => {
  function fake() {
    const create = vi.fn(async (_o: Record<string, unknown>) => ({
      sid: "SM123",
      status: "queued",
    }));
    return {
      create,
      client: { messages: { create } } as unknown as FakeTwilio,
    };
  }

  it("refuses the real SDK under test", async () => {
    setEnv({
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_FROM_NUMBER: "+15550100000",
    });
    await expect(
      transmit({ to: "+447700900123", body: "hi" }, { messageId: "m" }),
    ).rejects.toThrow(/Refusing to call Twilio/);
  });

  it("sends from TWILIO_FROM_NUMBER and asks for status callbacks on a public origin", async () => {
    setEnv({
      TWILIO_FROM_NUMBER: "+15550100000",
      TWILIO_WEBHOOK_BASE_URL: "https://app.example.com",
    });
    const { create, client } = fake();
    useFakeTwilio(client);
    expect(
      await transmit({ to: "+447700900123", body: "hi" }, { messageId: "m" }),
    ).toEqual({ providerMessageId: "SM123" });
    expect(create).toHaveBeenCalledWith({
      to: "+447700900123",
      from: "+15550100000",
      body: "hi",
      statusCallback: "https://app.example.com/api/webhooks/twilio/status",
    });
  });

  it("does not hand Twilio an unreachable callback URL", () => {
    setEnv({ TWILIO_WEBHOOK_BASE_URL: "http://localhost:3200" });
    expect(statusCallbackUrl()).toBeNull();
    setEnv({ TWILIO_WEBHOOK_BASE_URL: "http://192.168.1.4:3200" });
    expect(statusCallbackUrl()).toBeNull();
  });
});

describe("keywords and statuses", () => {
  it("matches opt-out keywords on the whole message only", () => {
    expect(smsKeyword(" STOP ")).toBe("stop");
    expect(smsKeyword("Unsubscribe.")).toBe("stop");
    expect(smsKeyword("start")).toBe("start");
    expect(smsKeyword("HELP")).toBe("help");
    expect(smsKeyword("stop by later?")).toBeNull();
    expect(smsKeyword("I want to cancel my booking")).toBeNull();
  });

  it("maps Twilio statuses and explains error codes", () => {
    expect(deliveryStatusOf("delivered")).toBe("delivered");
    expect(deliveryStatusOf("undelivered")).toBe("undelivered");
    expect(deliveryStatusOf("sent")).toBe("sent");
    expect(deliveryStatusOf("received")).toBeNull();
    expect(explainTwilioError("30005")).toMatch(/does not exist/);
    expect(explainTwilioError("99999")).toBe("Twilio 99999");
  });
});
