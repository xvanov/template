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
 * Channel packages (packages/email, packages/sms; push lives in packages/notify)
 * call `deliver` with their raw transport as the callback and DO NOT export
 * that transport. The callback receives the PARSED recipient and must send to
 * exactly that, and the row id, which a provider that supports it is given as
 * its idempotency key. See the "Outbound messages" section of CLAUDE.md.
 *
 * Idempotency: an attempt with an `idempotencyKey` reuses the row of an
 * earlier attempt with the same key IN THE SAME TENANT (keys are namespaced
 * by organization; rows with none share the "system" namespace). The earlier
 * row must be for the same channel and recipient, or the attempt throws a
 * ConflictError and nothing is sent. Then:
 *   sent                        → returned as sent; nothing is sent again
 *   pending, claimed recently   → "in_progress": another process is sending it
 *   failed / blocked / pending
 *   claimed > PENDING_STALE_MS  → the gates run again, and this attempt takes
 *                                 the row with a compare-and-set on the status
 *                                 (and claim time) it read. Exactly one of any
 *                                 number of racing retries wins; the others
 *                                 re-read and report what they find.
 * The send then reuses the row id, and so the provider idempotency key. SMTP
 * has no such key: a process that dies between the relay accepting a message
 * and the row being marked sent can still lead to one duplicate on a retry
 * after the stale window; so can Twilio, whose message API takes no key.
 * Resend drops a repeat of the same key for 24 hours.
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
  | { status: "blocked"; id: string; reason: Block["reason"]; detail: string }
  /**
   * Only with an idempotencyKey: another attempt with this key holds the row
   * and is sending it now. Nothing was sent by this call; retry later if the
   * outcome matters (a job can simply throw and be retried).
   */
  | { status: "in_progress"; id: string; detail: string };

/**
 * How long a "pending" row may be held before a retry may take it over: well
 * past the slowest transport's timeouts (SMTP: 3 x 30s).
 */
export const PENDING_STALE_MS = 5 * 60_000;

/** Namespace of idempotency keys on rows with no tenant. */
const SYSTEM_SCOPE = "system";

/**
 * The same idempotency key was used for a DIFFERENT message (another channel
 * or recipient). Named ConflictError so @repo/api maps it to CONFLICT.
 */
export class IdempotencyConflictError extends Error {
  override name = "ConflictError";
}

/** What a channel's transport returns once the provider has accepted it. */
export interface ProviderReceipt {
  providerMessageId?: string;
  /** e.g. "logged to console (SMTP_HOST unset)". */
  detail?: string;
}

/** What the transport is told besides the recipient. */
export interface SendMeta {
  /**
   * The outbound_message row id. Stable across retries of an attempt with an
   * idempotencyKey: pass it to the provider as ITS idempotency key (Resend's
   * Idempotency-Key header) and use it in the Message-ID, so a reply can be
   * threaded back to this row.
   */
  messageId: string;
}

export type Transport = (
  recipient: string,
  meta: SendMeta,
) => Promise<ProviderReceipt>;

export interface GuardDeps {
  db: Pick<
    PrismaClient,
    "outboundMessage" | "appSetting" | "outboundSuppression"
  >;
  /** Counter store for the volume caps. Default: Redis (memory under test). */
  store?: CounterStore;
  config: GuardConfig;
  /** The clock (tests move it past PENDING_STALE_MS). */
  now?: () => Date;
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
      sms: e.OUTBOUND_SMS_ENABLED,
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
  // No operator phone: operator alerts go by push or email (packages/notify).
  const raw = { email: e.OPERATOR_EMAIL, push: e.NTFY_TOPIC, sms: undefined };
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
        "[outbound] SAFE MODE: LOCAL CATCHER (OUTBOUND_SAFE_MODE=local) — EVERY email recipient allowed (push: operator only; sms: allowlist only).",
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
  send: Transport,
  deps: Partial<GuardDeps> = {},
): Promise<DeliveryResult> {
  const db = deps.db ?? defaultDb;
  const config = deps.config ?? configFromEnv();
  const now = deps.now ?? (() => new Date());
  const recipient = parseRecipient(attempt.channel, attempt.recipient);
  // The parsed address; an unparseable one is kept raw (truncated) so the log
  // shows what was attempted.
  const recordedRecipient = recipient ?? attempt.recipient.slice(0, 320);

  const key = attempt.idempotencyKey?.slice(0, 300);
  const scope = attempt.organizationId ?? SYSTEM_SCOPE;
  const readPrior = () =>
    key
      ? db.outboundMessage.findUnique({
          where: {
            idempotencyScope_idempotencyKey: {
              idempotencyScope: scope,
              idempotencyKey: key,
            },
          },
          select: PRIOR_SELECT,
        })
      : Promise.resolve(null);

  // An earlier attempt at this same logical message? Settled before the
  // gates, so a duplicate does not use up anyone's volume quota.
  const first = await readPrior();
  if (first) {
    assertSameMessage(first, attempt.channel, recordedRecipient);
    const settled = settledResult(first, now());
    if (settled) return settled;
  }

  const block = recipient
    ? await firstBlock({ ...attempt, recipient }, config, db, deps.store)
    : staticBlock(attempt, config, false);
  const outcome: {
    status: "blocked" | "pending";
    blockReason: Block["reason"] | null;
    detail: string | null;
    finishedAt: Date | null;
    claimedAt: Date | null;
  } =
    block || !recipient
      ? {
          status: "blocked" as const,
          blockReason: (block ?? { reason: "INVALID_RECIPIENT" }).reason,
          detail: (block ?? { detail: "Invalid recipient." }).detail,
          finishedAt: now(),
          claimedAt: null,
        }
      : {
          status: "pending" as const,
          blockReason: null,
          detail: null,
          finishedAt: null,
          claimedAt: now(),
        };

  /**
   * Write this attempt's row: a new one, or take over the prior attempt's.
   * Returns the row id this attempt owns, or the result to report when
   * another attempt with the same key got there first.
   */
  const claim = async (): Promise<{ id: string } | DeliveryResult> => {
    let prior = first;
    for (let round = 0; round < 3; round++) {
      if (prior) {
        assertSameMessage(prior, attempt.channel, recordedRecipient);
        const settled = settledResult(prior, now());
        if (settled) return settled;
        // Compare-and-set on exactly what we read: if anyone changed the row
        // since (another retry took it, or it was sent), this matches nothing
        // and we re-read instead of sending a second copy.
        const r = await db.outboundMessage.updateMany({
          where: {
            id: prior.id,
            status: prior.status,
            claimedAt: prior.claimedAt,
          },
          data: outcome,
        });
        if (r.count === 1) return { id: prior.id };
      } else {
        try {
          return await db.outboundMessage.create({
            data: {
              organizationId: attempt.organizationId ?? null,
              channel: attempt.channel,
              recipient: recordedRecipient,
              subject: attempt.subject?.slice(0, 300),
              purpose: attempt.purpose,
              actorUserId: attempt.actorUserId ?? null,
              idempotencyKey: key ?? null,
              idempotencyScope: key ? scope : null,
              ...outcome,
            },
            select: { id: true },
          });
        } catch (err) {
          // Another attempt with this key inserted first: look at its row.
          if (!(key && isUniqueViolation(err))) throw err;
        }
      }
      prior = await readPrior();
    }
    // Still contended after three rounds: someone else is on it.
    return {
      status: "in_progress",
      id: prior?.id ?? "",
      detail: "another attempt with this idempotency key holds the message",
    };
  };

  const claimed = await claim();
  if ("status" in claimed) return claimed;
  const { id } = claimed;

  if (outcome.status === "blocked") {
    const b = { reason: outcome.blockReason!, detail: outcome.detail ?? "" };
    console.warn(
      `[outbound] BLOCKED ${attempt.channel} to ${displayRecipient(attempt.channel, attempt.recipient)} (${attempt.purpose}): ${b.reason} — ${b.detail}`,
    );
    return { status: "blocked", id, ...b };
  }

  // The row is "pending" and ours. No row, no send: had the write thrown,
  // the provider would never have been called.
  //
  // Every later write is conditional on still holding THIS claim: if this
  // send was slow enough for the row to go stale and a retry took it over,
  // this attempt's late "failed" or "sent" must not overwrite the retry's
  // outcome (a late "failed" over a real "sent" would make the next retry
  // send a duplicate).
  const ours = {
    id,
    status: "pending",
    claimedAt: outcome.claimedAt,
  };
  let receipt: ProviderReceipt;
  try {
    receipt = await send(recipient!, { messageId: id });
  } catch (err) {
    await db.outboundMessage
      .updateMany({
        where: ours,
        data: {
          status: "failed",
          detail: (err instanceof Error ? err.message : String(err)).slice(
            0,
            1000,
          ),
          finishedAt: now(),
        },
      })
      .catch((logErr) =>
        console.error("[outbound] could not record a failed send:", logErr),
      );
    throw err;
  }

  // The provider HAS accepted the message. Failing to record that must not
  // turn into an error: a caller (a job) would retry and send it twice. The
  // row stays "pending", which is the honest state of what we know: a retry
  // with the same key reports it in progress until it goes stale, and then
  // sends it again (SMTP and Twilio cannot tell us they already have it).
  try {
    await db.outboundMessage.updateMany({
      where: ours,
      data: {
        status: "sent",
        providerMessageId: receipt.providerMessageId,
        detail: receipt.detail,
        finishedAt: now(),
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

const PRIOR_SELECT = {
  id: true,
  status: true,
  channel: true,
  recipient: true,
  claimedAt: true,
  providerMessageId: true,
  blockReason: true,
  detail: true,
} as const;

interface PriorRow {
  id: string;
  status: string;
  channel: string;
  recipient: string;
  claimedAt: Date | null;
  providerMessageId: string | null;
}

/** A key names ONE message: reusing it for another is a bug, not a retry. */
function assertSameMessage(
  prior: PriorRow,
  channel: string,
  recipient: string,
): void {
  if (prior.channel !== channel || prior.recipient !== recipient) {
    throw new IdempotencyConflictError(
      "This idempotency key was already used for a different message (another channel or recipient). Nothing was sent.",
    );
  }
}

/**
 * The result to report for a prior attempt that may not be taken over, or
 * null when it may (failed, blocked, or pending past the stale window).
 */
function settledResult(prior: PriorRow, now: Date): DeliveryResult | null {
  if (prior.status === "sent") {
    return {
      status: "sent",
      id: prior.id,
      providerMessageId: prior.providerMessageId ?? undefined,
      detail: "duplicate: already sent under this idempotency key",
    };
  }
  if (
    prior.status === "pending" &&
    prior.claimedAt &&
    now.getTime() - prior.claimedAt.getTime() < PENDING_STALE_MS
  ) {
    return {
      status: "in_progress",
      id: prior.id,
      detail: "another attempt with this idempotency key is sending it",
    };
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
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
