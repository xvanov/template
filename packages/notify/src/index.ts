/**
 * Operator notifications: how the app tells the person RUNNING it that
 * something needs attention: a job failed for good, a tenant hit the daily AI
 * cap, a new sign-up. Not for tenants' users (that is app mail via @repo/email).
 *
 *   await notifyOperator({
 *     title: "Job items.summarize failed for good",
 *     body: err.message,
 *     priority: "high",
 *     dedupeKey: `job-failed:${job.name}`,
 *   });
 *
 * Every call writes one `notification` row, whatever happens next:
 *   1. dedupe: the same dedupeKey within NOTIFY_DEDUPE_WINDOW_MINUTES (or the
 *      call's own window) is recorded as "deduped" and not sent. Serialised by
 *      an advisory lock per key, so two processes cannot both send it.
 *   2. routing (policy.ts): low priority, quiet hours and an exhausted daily
 *      budget HOLD it for the next digest; the rest is sent now.
 *   3. channel: ntfy push when NTFY_TOPIC is set, else email to OPERATOR_EMAIL,
 *      else the console. Push and email go through the outbound guard
 *      (`deliver`), as the operator: see `operator` in @repo/outbound for how
 *      safe mode treats it. A send the volume cap blocks is held for the
 *      digest rather than lost.
 *
 * It NEVER throws: an alert path that can take down the code it reports on is
 * worse than none. If even the database is unreachable, the alert is printed.
 *
 * Do not put customers' personal data in a title or body: on ntfy.sh it sits
 * on a public server, readable by anyone who learns the topic.
 */
import { db } from "@repo/db";
import { sendOperatorMail } from "@repo/email";
import { env } from "@repo/env";
import { deliver, type DeliveryResult } from "@repo/outbound";

import { operatorTopic, transmitPush, type PushMessage } from "./ntfy";
import {
  dueSlot,
  parseDigestTimes,
  parseQuietHours,
  renderDigest,
  route,
  type Priority,
} from "./policy";

export {
  PRIORITIES,
  dueSlot,
  inQuietHours,
  parseDigestTimes,
  parseQuietHours,
  renderDigest,
  route,
  type Priority,
} from "./policy";

export interface OperatorNotification {
  /** One line. */
  title: string;
  /** A few short lines. No customer PII (see the header). */
  body: string;
  priority: Priority;
  /** Same key within the window = recorded, not re-sent. e.g. `ai-cap:<org>:<day>`. */
  dedupeKey?: string;
  /** Overrides NOTIFY_DEDUPE_WINDOW_MINUTES for this key. */
  dedupeWindowMinutes?: number;
  /** Opened when the push is tapped (non-loopback http(s) only). */
  url?: string;
  /** ntfy tags: emoji shortcodes ("warning", "rotating_light") or words. */
  tags?: string[];
  /** Context only: which tenant this is about. The operator gets it, not the tenant. */
  organizationId?: string | null;
}

export type Channel = "push" | "email" | "console";

export interface NotifyResult {
  /** The notification row, or null when even the database was unreachable. */
  id: string | null;
  status:
    "sent" | "logged" | "held" | "deduped" | "blocked" | "failed" | "pending";
  channel: Channel;
}

export interface NotifyDeps {
  now?: Date;
  /** The ntfy HTTP call (tests pass a fake). */
  fetch?: typeof fetch;
}

/** Where operator notifications go with the current env. */
export function operatorChannel(): Channel {
  if (operatorTopic()) return "push";
  if (env().OPERATOR_EMAIL) return "email";
  return "console";
}

const MINUTE = 60_000;

export async function notifyOperator(
  n: OperatorNotification,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  let channel: Channel = "console";
  try {
    const e = env();
    channel = operatorChannel();
    const now = deps.now ?? new Date();
    const title = n.title.trim().slice(0, 250) || "(untitled)";
    const body = n.body.slice(0, 8000);
    const windowMs =
      (n.dedupeWindowMinutes ?? e.NOTIFY_DEDUPE_WINDOW_MINUTES) * MINUTE;

    const row = await db.$transaction(async (tx) => {
      const data = {
        priority: n.priority,
        title,
        body,
        url: n.url ?? null,
        tags: n.tags ?? [],
        dedupeKey: n.dedupeKey ?? null,
        channel,
        organizationId: n.organizationId ?? null,
        createdAt: now,
      };
      if (n.dedupeKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notify:${n.dedupeKey}`}, 0))`;
        const first = await tx.notification.findFirst({
          where: {
            dedupeKey: n.dedupeKey,
            status: { not: "deduped" },
            createdAt: { gte: new Date(now.getTime() - windowMs) },
          },
          select: { id: true },
        });
        if (first) {
          return tx.notification.create({
            data: {
              ...data,
              status: "deduped",
              error: `duplicate of ${first.id}`,
            },
            select: { id: true, status: true },
          });
        }
      }
      const sentLast24h =
        n.priority === "normal"
          ? await tx.notification.count({
              where: {
                priority: "normal",
                status: "sent",
                sentAt: { gte: new Date(now.getTime() - 24 * 60 * MINUTE) },
              },
            })
          : 0;
      const decision = route({
        priority: n.priority,
        sentLast24h,
        budget: e.NOTIFY_PUSH_BUDGET,
        quiet: parseQuietHours(e.NOTIFY_QUIET_HOURS),
        now,
        timeZone: e.APP_TIMEZONE,
      });
      return tx.notification.create({
        data: {
          ...data,
          status: decision.send ? "pending" : "held",
          error: decision.send ? null : decision.reason,
        },
        select: { id: true, status: true },
      });
    });

    if (row.status !== "pending") {
      log(row.status, n.priority, channel, title);
      return {
        id: row.id,
        status: row.status as NotifyResult["status"],
        channel,
      };
    }
    const status = await dispatch(
      row.id,
      channel,
      { title, body, priority: n.priority, tags: n.tags, url: n.url },
      deps,
    );
    return { id: row.id, status, channel };
  } catch (err) {
    // The database (or env) is gone. The alert must still go somewhere.
    console.error(
      `[notify] could not record/send "${n.title}" (${n.priority}):`,
      err instanceof Error ? err.message : err,
    );
    console.error(`[notify] ${n.title}\n${n.body}`);
    return { id: null, status: "failed", channel };
  }
}

/** Send one recorded notification and record the outcome. Never throws. */
async function dispatch(
  id: string,
  channel: Channel,
  msg: PushMessage,
  deps: NotifyDeps,
): Promise<NotifyResult["status"]> {
  let status: NotifyResult["status"];
  let error: string | null = null;
  let outboundMessageId: string | null = null;
  try {
    let result: DeliveryResult | null = null;
    if (channel === "console") {
      console.log(
        [
          "",
          `[notify] ── operator notification (${msg.priority}) — set NTFY_TOPIC or OPERATOR_EMAIL to receive these`,
          `[notify] ${msg.title}`,
          ...msg.body.split("\n").map((l) => `[notify]   ${l}`),
          ...(msg.url ? [`[notify]   ${msg.url}`] : []),
          "",
        ].join("\n"),
      );
    } else if (channel === "push") {
      result = await deliver(
        {
          channel: "push",
          recipient: operatorTopic() ?? "",
          subject: msg.title,
          purpose: "operator.notify",
          operator: true,
        },
        // The guard passes the topic it checked; publish to that one.
        (topic) => transmitPush(topic, msg, deps.fetch),
      );
    } else {
      result = await sendOperatorMail(
        {
          to: env().OPERATOR_EMAIL ?? "",
          subject: `[${msg.priority}] ${msg.title}`,
          text: [msg.body, msg.url].filter(Boolean).join("\n\n"),
        },
        "operator.notify",
      );
    }
    if (!result) status = "logged";
    else {
      outboundMessageId = result.id;
      if (result.status === "sent") status = "sent";
      else {
        // Over the volume cap: not lost, it waits for the next digest.
        status = result.reason === "VOLUME" ? "held" : "blocked";
        error = `${result.reason}: ${result.detail}`;
      }
    }
  } catch (err) {
    status = "failed";
    error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  }
  await db.notification
    .updateMany({
      where: { id },
      data: {
        status,
        error,
        outboundMessageId,
        sentAt:
          status === "sent" || status === "logged"
            ? (deps.now ?? new Date())
            : null,
      },
    })
    .catch((err: unknown) =>
      console.error("[notify] could not record the outcome:", err),
    );
  log(status, msg.priority, channel, msg.title, error);
  return status;
}

function log(
  status: string,
  priority: string,
  channel: Channel,
  title: string,
  error?: string | null,
) {
  console.log(
    `[notify] ${status} ${priority} via ${channel}: ${JSON.stringify(title)}${error ? ` (${error})` : ""}`,
  );
}

const LAST_SLOT = "notify.digest.lastSlot";

export interface DigestResult {
  slot: string;
  /** Held notifications carried by this digest (0 = nothing sent). */
  count: number;
  digestId: string | null;
  status: NotifyResult["status"] | null;
}

/**
 * Send the due digest, if a slot is due. Called by the worker's
 * `operator.digest` job every 15 minutes; returns null when no slot is due.
 * Claiming the slot and the held rows happens in one transaction under an
 * advisory lock, so two workers cannot send the same digest. An empty slot is
 * recorded and sends nothing.
 */
export async function runDigest(
  deps: NotifyDeps = {},
): Promise<DigestResult | null> {
  const e = env();
  const now = deps.now ?? new Date();
  const channel = operatorChannel();
  const claimed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LAST_SLOT}, 0))`;
    const last = await tx.appSetting.findUnique({ where: { key: LAST_SLOT } });
    const slot = dueSlot({
      times: parseDigestTimes(e.NOTIFY_DIGEST_TIMES),
      now,
      timeZone: e.APP_TIMEZONE,
      lastSlot: (last?.value as { slot?: string } | null)?.slot ?? null,
    });
    if (!slot) return null;
    await tx.appSetting.upsert({
      where: { key: LAST_SLOT },
      create: { key: LAST_SLOT, value: { slot }, updatedBy: "notify" },
      update: { value: { slot }, updatedBy: "notify" },
    });
    const held = await tx.notification.findMany({
      where: { status: "held" },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        id: true,
        priority: true,
        title: true,
        body: true,
        createdAt: true,
      },
    });
    if (!held.length) return { slot, digest: null, count: 0 };
    const text = renderDigest(held, slot);
    // Recorded as "low": it IS the low-priority stream, and so it never
    // counts against the normal-priority budget.
    const digest = await tx.notification.create({
      data: {
        priority: "low",
        title: text.title,
        body: text.body,
        dedupeKey: `digest:${slot}`,
        channel,
        status: "pending",
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.notification.updateMany({
      where: { id: { in: held.map((h) => h.id) }, status: "held" },
      data: { status: "digested", digestId: digest.id },
    });
    return { slot, digest: { id: digest.id, ...text }, count: held.length };
  });
  if (!claimed) return null;
  if (!claimed.digest) {
    return { slot: claimed.slot, count: 0, digestId: null, status: null };
  }
  const status = await dispatch(
    claimed.digest.id,
    channel,
    {
      title: claimed.digest.title,
      body: claimed.digest.body,
      priority: "low",
      ntfyPriority: 3, // you chose these times: an ordinary notification
      tags: ["inbox_tray"],
    },
    deps,
  );
  return {
    slot: claimed.slot,
    count: claimed.count,
    digestId: claimed.digest.id,
    status,
  };
}
