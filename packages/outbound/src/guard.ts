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
 *   3. safe mode             outside production, only OUTBOUND_SAFE_RECIPIENTS
 *                            receive anything (auth mail excepted, see policy.ts)
 *   4. suppression list      bounces, complaints, unsubscribes
 *   5. volume caps           per recipient, per org, global; Redis. Fails CLOSED:
 *                            if the counters cannot be read, nothing is sent.
 *
 * Every attempt writes one `outbound_message` row. For an allowed message the
 * row is written BEFORE the provider is called ("pending") and then marked
 * sent/failed, so a message cannot leave without a record: if the row cannot
 * be written, the provider is never called.
 *
 * Channel packages (packages/email today) call `deliver` with their raw
 * transport as the callback and DO NOT export that transport. See the
 * "Outbound messages" section of CLAUDE.md.
 */
import { db as defaultDb, type PrismaClient } from "@repo/db";
import { env } from "@repo/env";
import { rateLimit, type CounterStore } from "@repo/security";

import { findSuppression, isFrozen } from "./controls";
import {
  normalizeRecipient,
  parseSafeList,
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

export function configFromEnv(): GuardConfig {
  const e = env();
  return {
    safeMode: e.OUTBOUND_SAFE_MODE,
    safeRecipients: parseSafeList(e.OUTBOUND_SAFE_RECIPIENTS),
    enabled: {
      email: e.OUTBOUND_EMAIL_ENABLED,
      sms: e.OUTBOUND_SMS_ENABLED,
      push: e.OUTBOUND_PUSH_ENABLED,
    },
    frozen: e.OUTBOUND_FROZEN,
    caps: {
      recipientPerHour: e.OUTBOUND_CAP_RECIPIENT_PER_HOUR,
      orgPerHour: e.OUTBOUND_CAP_ORG_PER_HOUR,
      orgPerDay: e.OUTBOUND_CAP_ORG_PER_DAY,
      globalPerHour: e.OUTBOUND_CAP_GLOBAL_PER_HOUR,
    },
  };
}

/**
 * Run every gate; if all pass, call `send` (the raw provider call) and record
 * the outcome. Blocked messages RESOLVE with status "blocked" (a block is a
 * decision, not an error). A provider failure is recorded as "failed" and
 * then rethrown, so jobs retry it.
 */
export async function deliver(
  attempt: OutboundAttempt,
  send: () => Promise<ProviderReceipt>,
  deps: Partial<GuardDeps> = {},
): Promise<DeliveryResult> {
  const db = deps.db ?? defaultDb;
  const config = deps.config ?? configFromEnv();

  const block = await firstBlock(attempt, config, db, deps.store);
  const row = (status: string, extra: Record<string, unknown> = {}) =>
    db.outboundMessage.create({
      data: {
        organizationId: attempt.organizationId ?? null,
        channel: attempt.channel,
        recipient: normalizeRecipient(attempt.channel, attempt.recipient),
        subject: attempt.subject?.slice(0, 300),
        purpose: attempt.purpose,
        actorUserId: attempt.actorUserId ?? null,
        status,
        ...extra,
      },
      select: { id: true },
    });

  if (block) {
    const { id } = await row("blocked", {
      blockReason: block.reason,
      detail: block.detail,
      finishedAt: new Date(),
    });
    console.warn(
      `[outbound] BLOCKED ${attempt.channel} to ${attempt.recipient} (${attempt.purpose}): ${block.reason} — ${block.detail}`,
    );
    return { status: "blocked", id, ...block };
  }

  // No row, no send: if this insert throws, the provider is never called.
  const { id } = await row("pending");
  try {
    const receipt = await send();
    await db.outboundMessage.updateMany({
      where: { id },
      data: {
        status: "sent",
        providerMessageId: receipt.providerMessageId,
        detail: receipt.detail,
        finishedAt: new Date(),
      },
    });
    return { status: "sent", id, ...receipt };
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
}

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

  // Last, so a message blocked above does not use up anyone's quota.
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
