/**
 * The guard's decisions that need no I/O: who counts as safe, and which static
 * gate (if any) stops a message. Kept pure so every rule is unit-tested in
 * microseconds; guard.ts adds the gates that need the database or Redis.
 */

/**
 * Channels with a transport: email (packages/email), push (ntfy, in
 * packages/notify, operator alerts), sms (Twilio, in packages/sms) and
 * mobile_push (Expo push to the app, in packages/push-mobile). A new channel
 * is added here, with a recipient parser and an enable flag, in the same
 * change that adds its transport, not before.
 */
export type Channel = "email" | "push" | "sms" | "mobile_push";

export const CHANNELS: readonly Channel[] = [
  "email",
  "push",
  "sms",
  "mobile_push",
];

/** Why a message was not sent. Stored verbatim in outbound_message.blockReason. */
export type BlockReason =
  | "INVALID_RECIPIENT"
  | "CHANNEL_DISABLED"
  | "FROZEN"
  | "SAFE_MODE"
  | "SUPPRESSED"
  | "VOLUME"
  | "VOLUME_UNAVAILABLE";

/**
 * - `strict`: only allowlisted recipients (auth mail excepted).
 * - `local-catcher`: every recipient allowed. ONLY when explicitly requested
 *   (OUTBOUND_SAFE_MODE=local) outside production: the operator is asserting
 *   SMTP is a catcher like Mailpit. Loopback SMTP alone proves nothing (a local
 *   postfix relays to the internet), so it is never inferred. Logged loudly.
 * - `off`: real mail to real people.
 */
export type SafeMode = "strict" | "local-catcher" | "off";

export interface OutboundAttempt {
  channel: Channel;
  /**
   * email: exactly one plain address (lists and display names are blocked).
   * push: one ntfy topic name.
   * sms: one phone number in international form (+447700900123; spaces,
   *      dashes, dots and brackets are tolerated; normalised to E.164).
   * mobile_push: one Expo push token, `ExponentPushToken[...]`.
   */
  recipient: string;
  /** What is sending it, dotted and grep-able: `auth.verify-email`, `items.digest`. */
  purpose: string;
  /** The tenant this message is sent on behalf of. Null for system/auth mail. */
  organizationId?: string | null;
  actorUserId?: string | null;
  subject?: string;
  /**
   * The caller's stable name for this ONE logical message, e.g.
   * `invoice.42.reminder.2026-11`. Optional, but set it whenever the send runs
   * in something that retries (a job): a second deliver() with the same key
   * reuses the first attempt's outbound_message row, returns it untouched once
   * it was sent, and otherwise re-sends under the SAME provider idempotency key
   * (the row id), so the provider can drop a duplicate too. Unique per
   * tenant (organizationId; rows without one share a "system" namespace).
   * Reusing a key for another channel or recipient throws ConflictError.
   * See `deliver` for the in-progress and stale rules.
   */
  idempotencyKey?: string;
  /**
   * Mail the recipient JUST asked for by submitting this address to better-auth
   * (verification, password reset, magic link). Exempt from the safe-mode
   * allowlist ONLY: the address cannot be "the wrong recipient", and without
   * the exemption no one can sign up on a safe-mode environment. Every other
   * gate (kill switch, suppression, volume caps) still applies, and the
   * per-recipient cap stops sign-up being used to mail-bomb a stranger.
   * Never set this for anything else; grep for it in review.
   */
  authMail?: boolean;
  /**
   * A message to the person running the app (packages/notify). Exempt from the
   * safe-mode allowlist ONLY when the recipient is exactly the operator's own
   * configured address for this channel (GuardConfig.operatorRecipients), which
   * the guard checks itself: setting the flag on any other recipient exempts
   * nothing. Kill switch and suppression still apply; the verified operator
   * skips the per-recipient cap and counts in its own "operator" global pool.
   */
  operator?: boolean;
}

/**
 * What the guard learned about a recipient from the database, for the
 * safe-mode check. mobile_push only: the account the device token is
 * registered to (its device row → user), looked up by the guard itself from the
 * token, never taken from the caller.
 */
export interface RecipientFacts {
  /** The device owner's email, ONLY if verified; null otherwise. */
  deviceOwnerEmail?: string | null;
}

export interface GuardConfig {
  safeMode: SafeMode;
  /** Normalised entries: exact addresses, and `@domain` for whole domains. */
  safeRecipients: string[];
  enabled: Record<Channel, boolean>;
  /**
   * The operator's own recipient per channel (OPERATOR_EMAIL, NTFY_TOPIC),
   * already parsed. Only these can use the `operator` exemption.
   */
  operatorRecipients: Partial<Record<Channel, string>>;
  /** OUTBOUND_FROZEN (env). The runtime switch is read separately. */
  frozen: boolean;
  caps: {
    recipientPerHour: number;
    orgPerHour: number;
    orgPerDay: number;
    globalPerHour: number;
  };
}

export interface Block {
  reason: BlockReason;
  detail: string;
}

/**
 * Exactly ONE plain address (`local@domain`), lowercased, or null.
 *
 * Deliberately narrow. Mail libraries accept far more in a "to" string: a
 * comma- or semicolon-separated LIST, `Name <addr>` display forms, groups. Any
 * of those would let `stranger@gmail.com, dev@allowed.test` pass an allowlist
 * check on the raw string and then mail the stranger. Rejecting everything
 * but a plain address means the string the guard checked, capped and logged is
 * the string the transport sends to. `%` and `!` are refused in the local part
 * too: old relay routing (`victim%gmail.com@allowed.test`) can forward mail
 * from an allowlisted domain's server to somewhere else entirely.
 */
const PLAIN_EMAIL =
  /^[a-z0-9.#$&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** An ntfy topic: what ntfy itself accepts in a topic name. Case-sensitive. */
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An Expo push token. Case-sensitive, so never lowercased anywhere (the
 * allowlist keeps token entries as written).
 */
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** E.164: a plus, a non-zero country code digit, at most 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * One phone number in E.164 (`+447700900123`), or null.
 *
 * International form only: a national number (`07700 900123`, `(555)
 * 010-0001`) is refused rather than guessed at, because which country it
 * belongs to is a guess, and a wrong guess texts a stranger. `00` is accepted
 * as the international prefix. Spaces, dashes, dots and brackets are
 * formatting and removed; anything else (a comma, a letter, `;`, a second `+`)
 * makes it not ONE number, so it is refused, like an email list.
 */
export function parsePhone(raw: string): string | null {
  const t = raw.trim();
  if (!/^[+\d][\d\s().-]*$/.test(t)) return null;
  let digits = t.replace(/[\s().-]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  return E164.test(digits) ? digits : null;
}

export function parseRecipient(channel: Channel, raw: string): string | null {
  if (channel === "push") {
    const t = raw.trim();
    return NTFY_TOPIC.test(t) ? t : null;
  }
  if (channel === "sms") return parsePhone(raw);
  if (channel === "mobile_push") {
    const t = raw.trim();
    return EXPO_TOKEN.test(t) ? t : null;
  }
  const r = raw.trim().toLowerCase();
  return r.length <= 254 && PLAIN_EMAIL.test(r) ? r : null;
}

/**
 * `a@x.com, @example.com, +447700900123, ExponentPushToken[..]` → normalised
 * entries: addresses, `@domain`s, E.164 numbers and Expo push tokens (kept
 * as written: tokens are case-sensitive). Invalid entries are dropped.
 */
export function parseSafeList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .flatMap((t) => {
      const token = parseRecipient("mobile_push", t);
      if (token) return [token];
      const s = t.toLowerCase();
      if (s.startsWith("@"))
        return parseRecipient("email", `x${s}`) !== null ? [s] : [];
      if (s.includes("@"))
        return parseRecipient("email", s) !== null ? [s] : [];
      const phone = parsePhone(s);
      return phone ? [phone] : [];
    });
}

export function isSafeRecipient(
  channel: Channel,
  recipient: string,
  safeList: readonly string[],
  facts: RecipientFacts = {},
): boolean {
  // push has no allowlist (only the operator's own topic is ever sent to,
  // via the `operator` exemption).
  if (channel === "push") return false;
  const r = parseRecipient(channel, recipient);
  if (!r) return false;
  // A device: by its exact token, or by its owner's VERIFIED email (an
  // address or @domain entry), so "my own phone" is `me@myco.com` in the
  // list instead of a token that changes on every reinstall.
  if (channel === "mobile_push") {
    if (safeList.includes(r)) return true;
    const owner = facts.deviceOwnerEmail;
    return Boolean(owner) && isSafeRecipient("email", owner!, safeList);
  }
  // A number is allowed only by its exact entry: there is no "@domain" for
  // phones, and a prefix rule (+44…) would allowlist a whole country.
  if (channel === "sms") return safeList.includes(r);
  const domain = r.slice(r.indexOf("@"));
  return safeList.some((entry) => entry === r || entry === domain);
}

/**
 * What a person may be SHOWN of a recipient (the activity log, a log line).
 * An ntfy topic and an Expo push token are bearer secrets: whoever holds one
 * can push to that phone, or (for a token) re-register the device under
 * themselves. So they are masked everywhere outside the guard and the
 * transport; addresses and numbers are the org's own contacts and shown as is.
 */
export function maskRecipient(channel: string, recipient: string): string {
  if (channel === "push") return `${recipient.slice(0, 3)}…`;
  if (channel === "mobile_push") {
    const open = recipient.indexOf("[");
    return open >= 0
      ? `${recipient.slice(0, open + 5)}…]`
      : `${recipient.slice(0, 4)}…`;
  }
  return recipient;
}

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

export function isLoopbackHost(host: string | undefined): boolean {
  return Boolean(host && LOOPBACK.test(host.trim()));
}

/**
 * Safe mode from the environment:
 *   OUTBOUND_SAFE_MODE=false → off; true → strict;
 *   local → local-catcher, except in production, where it is refused and
 *           treated as strict (a copied dev .env must not open the gates);
 *   unset → off in production, strict everywhere else.
 */
export function resolveSafeMode(e: {
  OUTBOUND_SAFE_MODE?: boolean | "local";
  NODE_ENV: string;
}): SafeMode {
  if (e.OUTBOUND_SAFE_MODE === false) return "off";
  if (e.OUTBOUND_SAFE_MODE === true) return "strict";
  if (e.OUTBOUND_SAFE_MODE === "local") {
    return e.NODE_ENV === "production" ? "strict" : "local-catcher";
  }
  return e.NODE_ENV === "production" ? "off" : "strict";
}

/**
 * The gates decidable from config alone, in order. Returns the first that
 * blocks, or null. `runtimeFrozen` is the database kill switch, read by the
 * caller so this stays pure.
 */
export function staticBlock(
  attempt: OutboundAttempt,
  config: GuardConfig,
  runtimeFrozen: boolean,
  facts: RecipientFacts = {},
): Block | null {
  if (!parseRecipient(attempt.channel, attempt.recipient)) {
    return {
      reason: "INVALID_RECIPIENT",
      detail:
        "Not exactly one plain address (lists and display names are refused).",
    };
  }
  if (!config.enabled[attempt.channel]) {
    return {
      reason: "CHANNEL_DISABLED",
      detail: `OUTBOUND_${attempt.channel.toUpperCase()}_ENABLED is off.`,
    };
  }
  if (config.frozen || runtimeFrozen) {
    return {
      reason: "FROZEN",
      detail: config.frozen
        ? "OUTBOUND_FROZEN=true (env kill switch)."
        : "Runtime kill switch is on (npm run outbound:freeze -- off to lift).",
    };
  }
  if (
    effectiveSafeMode(config.safeMode, attempt.channel) === "strict" &&
    !attempt.authMail &&
    !isOperatorRecipient(attempt, config) &&
    !isSafeRecipient(
      attempt.channel,
      attempt.recipient,
      config.safeRecipients,
      facts,
    )
  ) {
    return {
      reason: "SAFE_MODE",
      detail:
        attempt.channel === "push"
          ? "Safe mode is on and push goes only to the operator's NTFY_TOPIC."
          : attempt.channel === "sms"
            ? "Safe mode is on and the number is not in OUTBOUND_SAFE_RECIPIENTS (exact E.164 entries)."
            : attempt.channel === "mobile_push"
              ? "Safe mode is on and neither the device token nor its owner's verified email is in OUTBOUND_SAFE_RECIPIENTS."
              : "Safe mode is on and the recipient is not in OUTBOUND_SAFE_RECIPIENTS.",
    };
  }
  return null;
}

/**
 * `local-catcher` asserts that SMTP is a catcher. It says nothing about any
 * other channel (ntfy, Twilio and Expo push have no catcher: a push or a text
 * reaches a real phone), so for every channel but email it means strict.
 */
export function effectiveSafeMode(mode: SafeMode, channel: Channel): SafeMode {
  return mode === "local-catcher" && channel !== "email" ? "strict" : mode;
}

/** The `operator` flag AND the recipient is the configured operator's own. */
export function isOperatorRecipient(
  attempt: OutboundAttempt,
  config: GuardConfig,
): boolean {
  if (!attempt.operator) return false;
  const own = config.operatorRecipients[attempt.channel];
  const r = parseRecipient(attempt.channel, attempt.recipient);
  return Boolean(own && r && r === own);
}

/**
 * Counter keys and limits for the volume gate, most specific first.
 * `attempt.recipient` must already be parsed (see `parseRecipient`).
 */
export function volumeBuckets(
  attempt: OutboundAttempt,
  config: GuardConfig,
): { key: string; limit: number; windowSeconds: number; label: string }[] {
  const ch = attempt.channel;
  const HOUR = 3600;
  // The VERIFIED operator (flag + configured recipient) is not capped per
  // recipient: the cap protects strangers from us, and an urgent alert must
  // not stop at the 11th of the hour. The operator global pool still applies.
  const operator = isOperatorRecipient(attempt, config);
  const buckets: {
    key: string;
    limit: number;
    windowSeconds: number;
    label: string;
  }[] = operator
    ? []
    : [
        {
          key: `outbound:${ch}:rcpt:${attempt.recipient}:h`,
          limit: config.caps.recipientPerHour,
          windowSeconds: HOUR,
          label: `${config.caps.recipientPerHour}/hour to this recipient`,
        },
      ];
  if (attempt.organizationId) {
    buckets.push(
      {
        key: `outbound:${ch}:org:${attempt.organizationId}:h`,
        limit: config.caps.orgPerHour,
        windowSeconds: HOUR,
        label: `${config.caps.orgPerHour}/hour for this organization`,
      },
      {
        key: `outbound:${ch}:org:${attempt.organizationId}:d`,
        limit: config.caps.orgPerDay,
        windowSeconds: 24 * HOUR,
        label: `${config.caps.orgPerDay}/day for this organization`,
      },
    );
  }
  // Auth mail gets its OWN global bucket: anonymous sign-ups are attacker-
  // driven, and must not be able to use up the hourly budget every tenant's
  // mail shares. Verified operator messages get theirs too, so an alert storm
  // cannot starve tenants' mail, nor a busy day of tenant mail silence the
  // alerts. The bare flag on any other recipient buys nothing: "app" pool.
  const pool = attempt.authMail ? "auth" : operator ? "operator" : "app";
  buckets.push({
    key: `outbound:${ch}:global:${pool}:h`,
    limit: config.caps.globalPerHour,
    windowSeconds: HOUR,
    label: `${config.caps.globalPerHour}/hour across the whole app (${pool} ${ch})`,
  });
  return buckets;
}
