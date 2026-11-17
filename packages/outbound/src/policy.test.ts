import { describe, expect, it } from "vitest";

import {
  isSafeRecipient,
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
  enabled: { email: true, push: true },
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
        config({ enabled: { email: false, push: true } }),
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
        config({ enabled: { email: true, push: false } }),
        false,
      )?.reason,
    ).toBe("CHANNEL_DISABLED");
    expect(staticBlock(push(), config(), true)?.reason).toBe("FROZEN");
  });

  it("operator messages count in their own global pool", () => {
    expect(volumeBuckets(push(), config()).map((b) => b.key)).toEqual([
      "outbound:push:rcpt:ops-topic-123:h",
      "outbound:push:global:operator:h",
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
