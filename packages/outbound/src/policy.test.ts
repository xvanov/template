import { describe, expect, it } from "vitest";

import {
  isSafeRecipient,
  normalizeRecipient,
  parseSafeList,
  staticBlock,
  volumeBuckets,
  type GuardConfig,
  type OutboundAttempt,
} from "./policy";

const config = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  safeMode: true,
  safeRecipients: parseSafeList("dev@team.test, @qa.test, +1 (555) 010-0000"),
  enabled: { email: true, sms: false, push: false },
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

describe("safe list", () => {
  it("matches exact addresses case-insensitively, whole domains, and phone numbers by digits", () => {
    const list = config().safeRecipients;
    expect(isSafeRecipient("email", " Dev@Team.TEST ", list)).toBe(true);
    expect(isSafeRecipient("email", "anyone@qa.test", list)).toBe(true);
    expect(isSafeRecipient("sms", "+15550100000", list)).toBe(true);
    expect(isSafeRecipient("email", "dev@team.test.evil.com", list)).toBe(
      false,
    );
  });

  it("does not let a look-alike domain through a @domain entry", () => {
    const list = parseSafeList("@qa.test");
    expect(isSafeRecipient("email", "x@evilqa.test", list)).toBe(false);
    expect(isSafeRecipient("email", "x@sub.qa.test", list)).toBe(false);
  });

  it("normalises phone numbers to one spelling", () => {
    expect(normalizeRecipient("sms", "+1 (555) 010-0000")).toBe("+15550100000");
  });
});

describe("static gates", () => {
  it("SAFE MODE blocks a non-allowlisted recipient — the incident this exists for", () => {
    expect(staticBlock(mail(), config(), false)?.reason).toBe("SAFE_MODE");
    expect(
      staticBlock(mail({ recipient: "dev@team.test" }), config(), false),
    ).toBeNull();
    expect(staticBlock(mail(), config({ safeMode: false }), false)).toBeNull();
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
        config({ enabled: { email: false, sms: false, push: false } }),
        false,
      )?.reason,
    ).toBe("CHANNEL_DISABLED");
  });

  it("blocks channels that are not enabled even for safe recipients", () => {
    expect(
      staticBlock(
        mail({ channel: "sms", recipient: "+15550100000" }),
        config(),
        false,
      )?.reason,
    ).toBe("CHANNEL_DISABLED");
  });

  it("refuses an empty recipient", () => {
    expect(
      staticBlock(mail({ recipient: "  " }), config(), false)?.reason,
    ).toBe("MISSING_RECIPIENT");
  });
});

describe("volume buckets", () => {
  it("counts per recipient, per org (hour + day) and globally; org buckets only with an org", () => {
    expect(volumeBuckets(mail(), config()).map((b) => b.key)).toEqual([
      "outbound:email:rcpt:stranger@real-customer.com:h",
      "outbound:email:org:org_1:h",
      "outbound:email:org:org_1:d",
      "outbound:email:global:h",
    ]);
    expect(
      volumeBuckets(mail({ organizationId: null }), config()),
    ).toHaveLength(2);
  });
});
