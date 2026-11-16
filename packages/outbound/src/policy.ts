/**
 * The guard's decisions that need no I/O: who counts as safe, and which static
 * gate (if any) stops a message. Kept pure so every rule is unit-tested in
 * microseconds; guard.ts adds the gates that need the database or Redis.
 */

export type Channel = "email" | "sms" | "push";

/** Why a message was not sent. Stored verbatim in outbound_message.blockReason. */
export type BlockReason =
  | "CHANNEL_DISABLED"
  | "FROZEN"
  | "SAFE_MODE"
  | "SUPPRESSED"
  | "VOLUME"
  | "VOLUME_UNAVAILABLE"
  | "MISSING_RECIPIENT";

export interface OutboundAttempt {
  channel: Channel;
  /** Email address, E.164 phone number, or push token. */
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
  safeMode: boolean;
  /** Normalised entries: exact recipients, and `@domain` for whole domains. */
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

/** One canonical spelling per recipient, so allowlists and suppression match. */
export function normalizeRecipient(
  channel: Channel,
  recipient: string,
): string {
  const r = recipient.trim();
  if (channel === "email") return r.toLowerCase();
  if (channel === "sms") {
    const digits = r.replace(/\D/g, "");
    return r.startsWith("+") ? `+${digits}` : digits;
  }
  return r;
}

/** `a@x.com, @example.com, +15551234567` → normalised entries. */
export function parseSafeList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s.includes("@")) return s.toLowerCase(); // an address or `@domain`
      if (/^\+?[\d\s().-]+$/.test(s)) return normalizeRecipient("sms", s);
      return s; // a push token
    });
}

export function isSafeRecipient(
  channel: Channel,
  recipient: string,
  safeList: readonly string[],
): boolean {
  const r = normalizeRecipient(channel, recipient);
  return safeList.some(
    (entry) =>
      entry === r ||
      (channel === "email" && entry.startsWith("@") && r.endsWith(entry)),
  );
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
  if (!attempt.recipient.trim()) {
    return { reason: "MISSING_RECIPIENT", detail: "No recipient." };
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
    config.safeMode &&
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

/** Counter keys and limits for the volume gate, most specific first. */
export function volumeBuckets(
  attempt: OutboundAttempt,
  config: GuardConfig,
): { key: string; limit: number; windowSeconds: number; label: string }[] {
  const ch = attempt.channel;
  const r = normalizeRecipient(ch, attempt.recipient);
  const HOUR = 3600;
  const buckets = [
    {
      key: `outbound:${ch}:rcpt:${r}:h`,
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
  buckets.push({
    key: `outbound:${ch}:global:h`,
    limit: config.caps.globalPerHour,
    windowSeconds: HOUR,
    label: `${config.caps.globalPerHour}/hour across the whole app`,
  });
  return buckets;
}
