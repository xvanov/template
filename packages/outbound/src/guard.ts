/**
 * THE OUTBOUND GUARD: the one function every outbound message passes through.
 *
 * Exists because of a real incident: a production app emailed the wrong
 * content to 8 real customers. The fix in each app was this chokepoint; this
 * is the generic version, so a new app starts with it instead of after its
 * own incident.
 *
 * Gates, in order (the first that fails blocks the message):
 *
 *   1. channel enabled       OUTBOUND_<CHANNEL>_ENABLED
 *   2. kill switch           OUTBOUND_FROZEN, or the runtime switch in app_setting
 *   0. recipient             exactly one plain address, or INVALID_RECIPIENT
 *   3. safe mode             outside production, only OUTBOUND_SAFE_RECIPIENTS
 *                            receive anything (auth mail and the operator's own
 *                            address/topic excepted; a local mail catcher allows
 *                            all EMAIL; see resolveSafeMode, effectiveSafeMode)
 *   4. suppression list      bounces, complaints, unsubscribes
 *   5. volume caps           per recipient, per org, global; Redis. Fails CLOSED:
 *                            if the counters cannot be read, nothing is sent.
 *
 * Every attempt writes one `outbound_message` row. For an allowed message the
 * row is written BEFORE the provider is called ("pending") and then marked
 * sent/failed, so a message cannot leave without a record: if the row cannot
 * be written, the provider is never called.
 *
 * Channel packages (packages/email; push lives in packages/notify) call `deliver` with their raw
 * transport as the callback and DO NOT export that transport. The callback
 * receives the PARSED recipient and must send to exactly that. See the
 * "Outbound messages" section of CLAUDE.md.
 */
import { db as defaultDb, type PrismaClient } from "@repo/db";
import { env } from "@repo/env";
import { rateLimit, type CounterStore } from "@repo/security";

import { findSuppression, isFrozen } from "./controls";
import {
  CHANNELS,
  parseRecipient,
  parseSafeList,
  resolveSafeMode,
  staticBlock,
  volumeBuckets,
  type Block,
  type GuardConfig,
  type OutboundAttempt,
} from "./policy";

export type DeliveryResult =
  | { status: "sent"; id: string; providerMessageId?: string; detail?: string }
  | { status: "blocked"; id: string; reason: Block["reason"]; detail: string };

/** What a channel's transport returns once the provider has accepted it. */
export interface ProviderReceipt {
  providerMessageId?: string;
  /** e.g. "logged to console (SMTP_HOST unset)". */
  detail?: string;
}

export interface GuardDeps {
  db: Pick<
    PrismaClient,
    "outboundMessage" | "appSetting" | "outboundSuppression"
  >;
  /** Counter store for the volume caps. Default: Redis (memory under test). */
  store?: CounterStore;
  config: GuardConfig;
}

let announced = false;

export function configFromEnv(): GuardConfig {
  const e = env();
  if (e.OUTBOUND_SAFE_MODE === "local" && e.NODE_ENV === "production") {
    console.error(
      "[outbound] OUTBOUND_SAFE_MODE=local is refused in production; using STRICT.",
    );
  }
  const config: GuardConfig = {
    safeMode: resolveSafeMode(e),
    safeRecipients: parseSafeList(e.OUTBOUND_SAFE_RECIPIENTS),
    enabled: {
      email: e.OUTBOUND_EMAIL_ENABLED,
      push: e.OUTBOUND_PUSH_ENABLED,
    },
    operatorRecipients: operatorRecipients(e),
    frozen: e.OUTBOUND_FROZEN,
    caps: {
      recipientPerHour: e.OUTBOUND_CAP_RECIPIENT_PER_HOUR,
      orgPerHour: e.OUTBOUND_CAP_ORG_PER_HOUR,
      orgPerDay: e.OUTBOUND_CAP_ORG_PER_DAY,
      globalPerHour: e.OUTBOUND_CAP_GLOBAL_PER_HOUR,
    },
  };
  if (!announced) {
    announced = true;
    console.warn(describeSafeMode(config, e.SMTP_HOST));
  }
  return config;
}

function operatorRecipients(e: {
  OPERATOR_EMAIL?: string;
  NTFY_TOPIC?: string;
}): GuardConfig["operatorRecipients"] {
  const raw = { email: e.OPERATOR_EMAIL, push: e.NTFY_TOPIC };
  const out: GuardConfig["operatorRecipients"] = {};
  for (const ch of CHANNELS) {
    const r = raw[ch] && parseRecipient(ch, raw[ch]);
    if (r) out[ch] = r;
  }
  return out;
}

/** What a log line may show of a recipient. A push topic is a secret. */
export function displayRecipient(channel: string, recipient: string): string {
  return channel === "push"
    ? `topic ${recipient.slice(0, 3)}…`
    : JSON.stringify(recipient);
}

/** One loud line saying what safe mode will do. Printed once per process. */
export function describeSafeMode(
  config: GuardConfig,
  smtpHost?: string,
): string {
  switch (config.safeMode) {
    case "local-catcher":
      return [
        "",
        "[outbound] SAFE MODE: LOCAL CATCHER (OUTBOUND_SAFE_MODE=local) — EVERY email recipient allowed (push: operator only).",
        `[outbound]   This trusts that SMTP (${smtpHost ?? "unset: console"}) is a catcher like Mailpit that`,
        "[outbound]   delivers nowhere. If it can relay to the internet, real people get this mail.",
        "",
      ].join("\n");
    case "strict":
      return `[outbound] SAFE MODE: STRICT — only OUTBOUND_SAFE_RECIPIENTS (${config.safeRecipients.length} entries), auth mail and operator notifications are sent.`;
    case "off":
      return "[outbound] safe mode off — messages go to real recipients.";
  }
}

/**
 * Run every gate; if all pass, call `send` (the raw provider call) with the
 * parsed recipient and record the outcome. Blocked messages RESOLVE with
 * status "blocked" (a block is a decision, not an error). A provider failure
 * is recorded as "failed" and then rethrown, so jobs retry it.
 */
export async function deliver(
  attempt: OutboundAttempt,
  send: (recipient: string) => Promise<ProviderReceipt>,
  deps: Partial<GuardDeps> = {},
): Promise<DeliveryResult> {
  const db = deps.db ?? defaultDb;
  const config = deps.config ?? configFromEnv();
  const recipient = parseRecipient(attempt.channel, attempt.recipient);

  const block = recipient
    ? await firstBlock({ ...attempt, recipient }, config, db, deps.store)
    : staticBlock(attempt, config, false);
  const row = (status: string, extra: Record<string, unknown> = {}) =>
    db.outboundMessage.create({
      data: {
        organizationId: attempt.organizationId ?? null,
        channel: attempt.channel,
        // The parsed address; an unparseable one is kept raw (truncated) so the
        // log shows what was attempted.
        recipient: recipient ?? attempt.recipient.slice(0, 320),
        subject: attempt.subject?.slice(0, 300),
        purpose: attempt.purpose,
        actorUserId: attempt.actorUserId ?? null,
        status,
        ...extra,
      },
      select: { id: true },
    });

  if (block || !recipient) {
    const b = block ?? {
      reason: "INVALID_RECIPIENT" as const,
      detail: "Invalid recipient.",
    };
    const { id } = await row("blocked", {
      blockReason: b.reason,
      detail: b.detail,
      finishedAt: new Date(),
    });
    console.warn(
      `[outbound] BLOCKED ${attempt.channel} to ${displayRecipient(attempt.channel, attempt.recipient)} (${attempt.purpose}): ${b.reason} — ${b.detail}`,
    );
    return { status: "blocked", id, ...b };
  }

  // No row, no send: if this insert throws, the provider is never called.
  const { id } = await row("pending");

  let receipt: ProviderReceipt;
  try {
    receipt = await send(recipient);
  } catch (err) {
    await db.outboundMessage
      .updateMany({
        where: { id },
        data: {
          status: "failed",
          detail: (err instanceof Error ? err.message : String(err)).slice(
            0,
            1000,
          ),
          finishedAt: new Date(),
        },
      })
      .catch((logErr) =>
        console.error("[outbound] could not record a failed send:", logErr),
      );
    throw err;
  }

  // The provider HAS accepted the message. Failing to record that must not
  // turn into an error: a caller (a job) would retry and send it twice. The
  // row stays "pending", which is the honest state of what we know.
  try {
    await db.outboundMessage.updateMany({
      where: { id },
      data: {
        status: "sent",
        providerMessageId: receipt.providerMessageId,
        detail: receipt.detail,
        finishedAt: new Date(),
      },
    });
  } catch (logErr) {
    console.error(
      `[outbound] sent message ${id}, but could not mark it sent:`,
      logErr,
    );
  }
  return { status: "sent", id, ...receipt };
}

/** `attempt.recipient` is already parsed. */
async function firstBlock(
  attempt: OutboundAttempt,
  config: GuardConfig,
  db: GuardDeps["db"],
  store: CounterStore | undefined,
): Promise<Block | null> {
  const fixed = staticBlock(
    attempt,
    config,
    await isFrozen(attempt.channel, db),
  );
  if (fixed) return fixed;

  const suppressed = await findSuppression(
    attempt.channel,
    attempt.recipient,
    attempt.organizationId,
    db,
  );
  if (suppressed) {
    return {
      reason: "SUPPRESSED",
      detail: `Suppressed${suppressed.organizationId ? " for this organization" : ""}: ${suppressed.reason}`,
    };
  }

  // Last, so a message blocked above does not use up anyone's quota. Within
  // this loop, though, the buckets BEFORE the one that blocks have already
  // been incremented: a message stopped by the org cap still counts against
  // the recipient's. Accepted: it only ever errs towards sending less.
  for (const bucket of volumeBuckets(attempt, config)) {
    try {
      const r = await rateLimit({ ...bucket, store });
      if (!r.allowed) {
        return {
          reason: "VOLUME",
          detail: `Volume cap reached: ${bucket.label}.`,
        };
      }
    } catch (err) {
      return {
        reason: "VOLUME_UNAVAILABLE",
        detail: `Volume counters unreachable, failing closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return null;
}
