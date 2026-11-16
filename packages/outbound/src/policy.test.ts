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
  enabled: { email: true },
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
  it("an explicit setting always wins", () => {
    expect(
      resolveSafeMode({ OUTBOUND_SAFE_MODE: true, NODE_ENV: "production" }),
    ).toBe("strict");
    expect(
      resolveSafeMode({
        OUTBOUND_SAFE_MODE: false,
        NODE_ENV: "development",
        SMTP_HOST: "smtp.x",
      }),
    ).toBe("off");
  });

  it("unset: off in production; allow-all for a local catcher; strict for any other SMTP host", () => {
    expect(
      resolveSafeMode({ NODE_ENV: "production", SMTP_HOST: "smtp.x" }),
    ).toBe("off");
    expect(
      resolveSafeMode({ NODE_ENV: "development", SMTP_HOST: "localhost" }),
    ).toBe("local-catcher");
    expect(
      resolveSafeMode({ NODE_ENV: "development", SMTP_HOST: "127.0.0.1" }),
    ).toBe("local-catcher");
    expect(resolveSafeMode({ NODE_ENV: "development" })).toBe("local-catcher");
    expect(
      resolveSafeMode({
        NODE_ENV: "development",
        SMTP_HOST: "smtp.relay.example",
      }),
    ).toBe("strict");
    expect(
      resolveSafeMode({ NODE_ENV: "development", SMTP_HOST: "mailpit" }),
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
        config({ enabled: { email: false } }),
        false,
      )?.reason,
    ).toBe("CHANNEL_DISABLED");
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
