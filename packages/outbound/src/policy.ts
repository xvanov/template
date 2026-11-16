/**
 * The guard's decisions that need no I/O: who counts as safe, and which static
 * gate (if any) stops a message. Kept pure so every rule is unit-tested in
 * microseconds; guard.ts adds the gates that need the database or Redis.
 */

/**
 * Channels with a transport. Only email today: add "sms" / "push" here, with a
 * recipient parser and an enable flag, in the same change that adds the
 * transport, not before.
 */
export type Channel = "email";

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
 * - `local-catcher`: outside production, with mail going to a catcher on this
 *   machine (loopback SMTP, e.g. Mailpit) or to the console: nothing can reach
 *   a real inbox, so every recipient is allowed. Logged loudly.
 * - `off`: production, or OUTBOUND_SAFE_MODE=false.
 */
export type SafeMode = "strict" | "local-catcher" | "off";

export interface OutboundAttempt {
  channel: Channel;
  /** Exactly one plain email address. Lists and display names are blocked. */
  recipient: string;
  /** What is sending it, dotted and grep-able: `auth.verify-email`, `items.digest`. */
  purpose: string;
  /** The tenant this message is sent on behalf of. Null for system/auth mail. */
  organizationId?: string | null;
  actorUserId?: string | null;
  subject?: string;
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
}

export interface GuardConfig {
  safeMode: SafeMode;
  /** Normalised entries: exact addresses, and `@domain` for whole domains. */
  safeRecipients: string[];
  enabled: Record<Channel, boolean>;
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
 * the string the transport sends to.
 */
const PLAIN_EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function parseRecipient(_channel: Channel, raw: string): string | null {
  const r = raw.trim().toLowerCase();
  return r.length <= 254 && PLAIN_EMAIL.test(r) ? r : null;
}

/** `a@x.com, @example.com` → normalised entries. Invalid entries are dropped. */
export function parseSafeList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) =>
      s.startsWith("@")
        ? parseRecipient("email", `x${s}`) !== null
        : parseRecipient("email", s) !== null,
    );
}

export function isSafeRecipient(
  channel: Channel,
  recipient: string,
  safeList: readonly string[],
): boolean {
  const r = parseRecipient(channel, recipient);
  if (!r) return false;
  const domain = r.slice(r.indexOf("@"));
  return safeList.some((entry) => entry === r || entry === domain);
}

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

export function isLoopbackHost(host: string | undefined): boolean {
  return Boolean(host && LOOPBACK.test(host.trim()));
}

/**
 * Safe mode from the environment. An explicit OUTBOUND_SAFE_MODE always wins;
 * unset, it is off in production, `local-catcher` when SMTP is loopback or
 * unset (console), and `strict` whenever SMTP points anywhere else.
 */
export function resolveSafeMode(e: {
  OUTBOUND_SAFE_MODE?: boolean;
  NODE_ENV: string;
  SMTP_HOST?: string;
}): SafeMode {
  if (e.OUTBOUND_SAFE_MODE === false) return "off";
  if (e.OUTBOUND_SAFE_MODE === true) return "strict";
  if (e.NODE_ENV === "production") return "off";
  if (!e.SMTP_HOST || isLoopbackHost(e.SMTP_HOST)) return "local-catcher";
  return "strict";
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
    config.safeMode === "strict" &&
    !attempt.authMail &&
    !isSafeRecipient(attempt.channel, attempt.recipient, config.safeRecipients)
  ) {
    return {
      reason: "SAFE_MODE",
      detail:
        "Safe mode is on and the recipient is not in OUTBOUND_SAFE_RECIPIENTS.",
    };
  }
  return null;
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
  const buckets = [
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
  // mail shares.
  const pool = attempt.authMail ? "auth" : "app";
  buckets.push({
    key: `outbound:${ch}:global:${pool}:h`,
    limit: config.caps.globalPerHour,
    windowSeconds: HOUR,
    label: `${config.caps.globalPerHour}/hour across the whole app (${pool} mail)`,
  });
  return buckets;
}
