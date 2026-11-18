import { describe, expect, it } from "vitest";

import {
  effectiveSafeMode,
  isSafeRecipient,
  maskRecipient,
  parsePhone,
  parseRecipient,
  parseSafeList,
  resolveSafeMode,
  staticBlock,
  volumeBuckets,
  type GuardConfig,
  type OutboundAttempt,
} from "./policy";

const config = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  safeMode: "strict",
  safeRecipients: parseSafeList("dev@team.test, @example.com"),
  enabled: { email: true, push: true, sms: true, mobile_push: true },
  operatorRecipients: { email: "ops@team.test", push: "ops-topic-123" },
  frozen: false,
  caps: {
    recipientPerHour: 10,
    orgPerHour: 200,
    orgPerDay: 2000,
    globalPerHour: 2000,
  },
  ...over,
});

const mail = (over: Partial<OutboundAttempt> = {}): OutboundAttempt => ({
  channel: "email",
  recipient: "stranger@real-customer.com",
  purpose: "items.digest",
  organizationId: "org_1",
  ...over,
});

/** Strings a mail library would happily deliver to more than one person. */
const BYPASS_FORMS = [
  "victim@gmail.com, me@example.com",
  "victim@gmail.com,me@example.com",
  "victim@gmail.com; me@example.com",
  "Me <me@example.com>, victim@gmail.com",
  '"me@example.com" <victim@gmail.com>',
  "Victim <victim@gmail.com>",
  "me@example.com\nBcc: victim@gmail.com",
  "victim@gmail.com me@example.com",
  "undisclosed:victim@gmail.com;",
  "victim%gmail.com@example.com",
  "gmail.com!victim@example.com",
];

describe("parseRecipient", () => {
  it("accepts exactly one plain address, lowercased", () => {
    expect(parseRecipient("email", "  Dev@Team.TEST ")).toBe("dev@team.test");
    expect(parseRecipient("email", "dev@localhost")).toBe("dev@localhost");
  });

  it.each(BYPASS_FORMS)("refuses list / display-name form %j", (raw) => {
    expect(parseRecipient("email", raw)).toBeNull();
  });
});

describe("safe list", () => {
  it("matches exact addresses and whole domains", () => {
    const list = config().safeRecipients;
    expect(isSafeRecipient("email", " Dev@Team.TEST ", list)).toBe(true);
    expect(isSafeRecipient("email", "anyone@example.com", list)).toBe(true);
    expect(isSafeRecipient("email", "dev@team.test.evil.com", list)).toBe(
      false,
    );
  });

  it("does not let a look-alike or sub-domain through a @domain entry", () => {
    const list = parseSafeList("@qa.test");
    expect(isSafeRecipient("email", "x@evilqa.test", list)).toBe(false);
    expect(isSafeRecipient("email", "x@sub.qa.test", list)).toBe(false);
  });

  it.each(BYPASS_FORMS)("is never fooled by %j", (raw) => {
    expect(isSafeRecipient("email", raw, config().safeRecipients)).toBe(false);
    expect(staticBlock(mail({ recipient: raw }), config(), false)?.reason).toBe(
      "INVALID_RECIPIENT",
    );
    // Not even auth mail, and not even with safe mode off.
    expect(
      staticBlock(
        mail({ recipient: raw, authMail: true }),
        config({ safeMode: "off" }),
        false,
      )?.reason,
    ).toBe("INVALID_RECIPIENT");
  });
});

describe("resolveSafeMode", () => {
  it("true is strict and false is off, anywhere", () => {
    expect(
      resolveSafeMode({ OUTBOUND_SAFE_MODE: true, NODE_ENV: "production" }),
    ).toBe("strict");
    expect(
      resolveSafeMode({ OUTBOUND_SAFE_MODE: false, NODE_ENV: "development" }),
    ).toBe("off");
  });

  it("unset: off in production, STRICT everywhere else — loopback SMTP is never trusted", () => {
    expect(resolveSafeMode({ NODE_ENV: "production" })).toBe("off");
    expect(resolveSafeMode({ NODE_ENV: "development" })).toBe("strict");
    expect(resolveSafeMode({ NODE_ENV: "test" })).toBe("strict");
  });

  it("allow-all only when explicitly asked for, and never in production", () => {
    expect(
      resolveSafeMode({ OUTBOUND_SAFE_MODE: "local", NODE_ENV: "development" }),
    ).toBe("local-catcher");
    expect(
      resolveSafeMode({ OUTBOUND_SAFE_MODE: "local", NODE_ENV: "production" }),
    ).toBe("strict");
  });
});

describe("static gates", () => {
  it("SAFE MODE blocks a non-allowlisted recipient — the incident this exists for", () => {
    expect(staticBlock(mail(), config(), false)?.reason).toBe("SAFE_MODE");
    expect(
      staticBlock(mail({ recipient: "dev@team.test" }), config(), false),
    ).toBeNull();
    expect(staticBlock(mail(), config({ safeMode: "off" }), false)).toBeNull();
    expect(
      staticBlock(mail(), config({ safeMode: "local-catcher" }), false),
    ).toBeNull();
  });

  it("lets auth mail (the address that just signed up) through safe mode, and nothing else", () => {
    expect(staticBlock(mail({ authMail: true }), config(), false)).toBeNull();
  });

  it("auth mail still obeys the kill switch and the channel switch", () => {
    expect(staticBlock(mail({ authMail: true }), config(), true)?.reason).toBe(
      "FROZEN",
    );
    expect(
      staticBlock(mail({ authMail: true }), config({ frozen: true }), false)
        ?.reason,
    ).toBe("FROZEN");
    expect(
      staticBlock(
        mail({ authMail: true }),
        config({
          enabled: { email: false, push: true, sms: true, mobile_push: true },
        }),
        false,
      )?.reason,
    ).toBe("CHANNEL_DISABLED");
  });
});

describe("push and operator messages", () => {
  const push = (over: Partial<OutboundAttempt> = {}): OutboundAttempt => ({
    channel: "push",
    recipient: "ops-topic-123",
    purpose: "operator.notify",
    operator: true,
    ...over,
  });

  it("a push recipient is one ntfy topic, case kept; anything else is invalid", () => {
    expect(parseRecipient("push", " Ops-Topic_1 ")).toBe("Ops-Topic_1");
    for (const bad of ["", "a/b", "a b", "x".repeat(65), "https://ntfy.sh/a"]) {
      expect(parseRecipient("push", bad)).toBeNull();
    }
  });

  it("strict: the operator's own topic and address pass; the flag on any other recipient exempts nothing", () => {
    expect(staticBlock(push(), config(), false)).toBeNull();
    expect(
      staticBlock(
        mail({ recipient: "ops@team.test", operator: true }),
        config({ safeRecipients: [] }),
        false,
      ),
    ).toBeNull();
    expect(
      staticBlock(push({ recipient: "someone-else" }), config(), false)?.reason,
    ).toBe("SAFE_MODE");
    expect(staticBlock(mail({ operator: true }), config(), false)?.reason).toBe(
      "SAFE_MODE",
    );
    // Without the flag even the operator's topic is not exempt.
    expect(
      staticBlock(push({ operator: false }), config(), false)?.reason,
    ).toBe("SAFE_MODE");
    // No operator configured: nothing is exempt.
    expect(
      staticBlock(push(), config({ operatorRecipients: {} }), false)?.reason,
    ).toBe("SAFE_MODE");
  });

  it("the email allowlist never admits a push topic", () => {
    expect(isSafeRecipient("push", "ops-topic-123", ["@example.com"])).toBe(
      false,
    );
  });

  it("local-catcher opens EMAIL only: a push reaches a real phone, so it stays strict", () => {
    const local = config({ safeMode: "local-catcher" });
    expect(staticBlock(mail(), local, false)).toBeNull();
    expect(
      staticBlock(push({ recipient: "stranger-topic" }), local, false)?.reason,
    ).toBe("SAFE_MODE");
    expect(staticBlock(push(), local, false)).toBeNull();
  });

  it("push has its own channel switch and obeys the kill switch", () => {
    expect(
      staticBlock(
        push(),
        config({
          enabled: { email: true, push: false, sms: true, mobile_push: true },
        }),
        false,
      )?.reason,
    ).toBe("CHANNEL_DISABLED");
    expect(staticBlock(push(), config(), true)?.reason).toBe("FROZEN");
  });

  it("the verified operator skips the per-recipient cap and counts in its own global pool", () => {
    expect(volumeBuckets(push(), config()).map((b) => b.key)).toEqual([
      "outbound:push:global:operator:h",
    ]);
    expect(
      volumeBuckets(
        mail({
          recipient: "ops@team.test",
          operator: true,
          organizationId: null,
        }),
        config(),
      ).map((b) => b.key),
    ).toEqual(["outbound:email:global:operator:h"]);
  });

  it("the operator flag on any other recipient buys no cap exemption and no operator pool", () => {
    expect(
      volumeBuckets(
        mail({ operator: true, organizationId: null }),
        config(),
      ).map((b) => b.key),
    ).toEqual([
      "outbound:email:rcpt:stranger@real-customer.com:h",
      "outbound:email:global:app:h",
    ]);
  });
});

describe("volume buckets", () => {
  it("counts per recipient, per org (hour + day) and globally; org buckets only with an org", () => {
    expect(volumeBuckets(mail(), config()).map((b) => b.key)).toEqual([
      "outbound:email:rcpt:stranger@real-customer.com:h",
      "outbound:email:org:org_1:h",
      "outbound:email:org:org_1:d",
      "outbound:email:global:app:h",
    ]);
    expect(
      volumeBuckets(mail({ organizationId: null }), config()),
    ).toHaveLength(2);
  });

  it("auth mail has its own global bucket, so sign-up floods cannot starve tenants' mail", () => {
    const auth = volumeBuckets(
      mail({ organizationId: null, authMail: true }),
      config(),
    );
    expect(auth.at(-1)?.key).toBe("outbound:email:global:auth:h");
  });
});

describe("sms recipients", () => {
  const text = (over: Partial<OutboundAttempt> = {}): OutboundAttempt =>
    mail({ channel: "sms", recipient: "+447700900123", ...over });

  it("normalises international numbers to E.164", () => {
    expect(parsePhone("+44 7700 900123")).toBe("+447700900123");
    expect(parsePhone(" +1 (555) 010-0001 ")).toBe("+15550100001");
    expect(parsePhone("+1.555.010.0001")).toBe("+15550100001");
    expect(parsePhone("0044 7700 900123")).toBe("+447700900123");
  });

  it("refuses national numbers, lists and anything that is not ONE number", () => {
    for (const raw of [
      "07700 900123", // national: which country is a guess
      "(555) 010-0001",
      "5550100001",
      "+15550100001, +447700900123",
      "+15550100001;+447700900123",
      "+15550100001 +447700900123", // two numbers
      "+1555010000a",
      "tel:+15550100001",
      "+0123456789", // no country code 0
      "+1234567", // too short
      "+1234567890123456", // too long
      "",
    ]) {
      expect(parseRecipient("sms", raw), raw).toBeNull();
    }
  });

  it("the allowlist holds exact numbers, normalised; no domain or prefix rules", () => {
    const list = parseSafeList("dev@team.test, +44 7700 900123, 07700900999");
    expect(list).toEqual(["dev@team.test", "+447700900123"]);
    expect(isSafeRecipient("sms", "+447700900123", list)).toBe(true);
    expect(isSafeRecipient("sms", "00447700900123", list)).toBe(true);
    expect(isSafeRecipient("sms", "+447700900124", list)).toBe(false);
    // An email entry never allows a number, nor a number an email.
    expect(isSafeRecipient("sms", "dev@team.test", list)).toBe(false);
  });

  it("strict safe mode blocks a stranger's number and allows a listed one", () => {
    const cfg = config({ safeRecipients: parseSafeList("+447700900123") });
    expect(
      staticBlock(text({ recipient: "+15550100001" }), cfg, false),
    ).toEqual(expect.objectContaining({ reason: "SAFE_MODE" }));
    expect(staticBlock(text(), cfg, false)).toBeNull();
  });

  it("the local mail catcher does NOT open sms: a text reaches a real phone", () => {
    expect(effectiveSafeMode("local-catcher", "sms")).toBe("strict");
    const cfg = config({ safeMode: "local-catcher", safeRecipients: [] });
    expect(staticBlock(text(), cfg, false)).toEqual(
      expect.objectContaining({ reason: "SAFE_MODE" }),
    );
    // ...while email to the same stranger passes in local-catcher mode.
    expect(staticBlock(mail(), cfg, false)).toBeNull();
  });

  it("is off unless OUTBOUND_SMS_ENABLED, and authMail does not exempt a number from the switch", () => {
    const cfg = config({
      enabled: { email: true, push: true, sms: false, mobile_push: true },
      safeMode: "off",
    });
    expect(staticBlock(text({ authMail: true }), cfg, false)).toEqual(
      expect.objectContaining({ reason: "CHANNEL_DISABLED" }),
    );
  });

  it("a recipient list is INVALID_RECIPIENT before any other gate", () => {
    expect(
      staticBlock(
        text({ recipient: "+15550100001,+447700900123" }),
        config({ safeRecipients: parseSafeList("+447700900123") }),
        false,
      ),
    ).toEqual(expect.objectContaining({ reason: "INVALID_RECIPIENT" }));
  });
});

describe("mobile_push recipients (Expo push tokens)", () => {
  const TOKEN = "ExponentPushToken[AbC-123_xyzQRS]";
  const device = (over: Partial<OutboundAttempt> = {}): OutboundAttempt => ({
    channel: "mobile_push",
    recipient: TOKEN,
    purpose: "push.proposal",
    organizationId: "org_1",
    ...over,
  });

  it("a recipient is exactly one Expo token, case kept; anything else is invalid", () => {
    expect(parseRecipient("mobile_push", ` ${TOKEN} `)).toBe(TOKEN);
    expect(parseRecipient("mobile_push", "ExpoPushToken[abcdefgh12]")).toBe(
      "ExpoPushToken[abcdefgh12]",
    );
    for (const bad of [
      TOKEN.toLowerCase(),
      `${TOKEN},${TOKEN}`,
      "ExponentPushToken[]",
      "dev@team.test",
      "+447700900123",
      "ExponentPushToken[a b]",
    ]) {
      expect(parseRecipient("mobile_push", bad), bad).toBeNull();
    }
  });

  it("the safe list keeps a token entry as written (tokens are case-sensitive)", () => {
    expect(parseSafeList(`Dev@Team.test, ${TOKEN}`)).toEqual([
      "dev@team.test",
      TOKEN,
    ]);
  });

  it("strict: allowed by its exact token, or by its owner's verified email or @domain", () => {
    const list = parseSafeList(`dev@team.test, @example.com, ${TOKEN}`);
    expect(isSafeRecipient("mobile_push", TOKEN, list)).toBe(true);
    const other = "ExponentPushToken[someoneElse99]";
    expect(isSafeRecipient("mobile_push", other, list)).toBe(false);
    expect(
      isSafeRecipient("mobile_push", other, list, {
        deviceOwnerEmail: "dev@team.test",
      }),
    ).toBe(true);
    expect(
      isSafeRecipient("mobile_push", other, list, {
        deviceOwnerEmail: "anyone@example.com",
      }),
    ).toBe(true);
    expect(
      isSafeRecipient("mobile_push", other, list, {
        deviceOwnerEmail: "customer@real.com",
      }),
    ).toBe(false);
    // Unverified owners arrive as null (the guard's lookup): nothing passes.
    expect(
      isSafeRecipient("mobile_push", other, list, { deviceOwnerEmail: null }),
    ).toBe(false);
  });

  it("an email entry never admits an email-shaped string as a device", () => {
    const list = parseSafeList("dev@team.test");
    expect(isSafeRecipient("mobile_push", "dev@team.test", list)).toBe(false);
  });

  it("the local mail catcher does NOT open mobile push: it reaches a real phone", () => {
    expect(effectiveSafeMode("local-catcher", "mobile_push")).toBe("strict");
    expect(
      staticBlock(device(), config({ safeMode: "local-catcher" }), false),
    ).toMatchObject({
      reason: "SAFE_MODE",
      detail: expect.stringContaining("device token nor its owner"),
    });
    expect(
      staticBlock(device(), config({ safeMode: "local-catcher" }), false, {
        deviceOwnerEmail: "dev@team.test",
      }),
    ).toBeNull();
  });

  it("is off unless OUTBOUND_MOBILE_PUSH_ENABLED, and obeys the kill switch", () => {
    const off = config({
      safeMode: "off",
      enabled: { email: true, push: true, sms: true, mobile_push: false },
    });
    expect(staticBlock(device(), off, false)).toMatchObject({
      reason: "CHANNEL_DISABLED",
      detail: "OUTBOUND_MOBILE_PUSH_ENABLED is off.",
    });
    expect(
      staticBlock(device(), config({ safeMode: "off" }), true),
    ).toMatchObject({ reason: "FROZEN" });
  });
});

describe("maskRecipient: what a person may be shown", () => {
  it("masks push secrets (Expo tokens, ntfy topics), shows contacts as they are", () => {
    const token = "ExponentPushToken[AbCdEfGhIjKlMn]";
    expect(maskRecipient("mobile_push", token)).toBe(
      "ExponentPushToken[AbCd…]",
    );
    expect(maskRecipient("mobile_push", token)).not.toContain("EfGh");
    expect(maskRecipient("push", "secret-topic-123")).toBe("sec…");
    expect(maskRecipient("email", "a@b.test")).toBe("a@b.test");
    expect(maskRecipient("sms", "+447700900123")).toBe("+447700900123");
  });
});
