/**
 * Operator notifications: how the app tells the person RUNNING it that
 * something needs attention: a job failed for good, a tenant hit the daily AI
 * cap, a new sign-up. Not for tenants' users (that is app mail via @repo/email).
 *
 *   await notifyOperator({
 *     title: "Job items.summarize failed for good",
 *     body: "attempt 3 · ZodError: invalid payload",
 *     priority: "high",
 *     dedupeKey: `job-failed:${job.name}`,
 *   });
 *
 * Every call writes one `notification` row, whatever happens next:
 *   1. dedupe: the same dedupeKey within NOTIFY_DEDUPE_WINDOW_MINUTES (or the
 *      call's own window) is recorded as "deduped" and not sent, but ONLY if
 *      the earlier one actually reached the operator (or is about to: held for
 *      the digest, or in flight right now). A failed or blocked alert does not
 *      silence its repeats. Serialised by an advisory lock per key.
 *   2. `low` is held for the next digest; everything else is sent now.
 *   3. channel: ntfy push when NTFY_TOPIC is set, else email to OPERATOR_EMAIL,
 *      else the console. Push and email go through the outbound guard as the
 *      operator (see `operator` in @repo/outbound for how safe mode treats it).
 *      A send the guard's volume cap blocks is held: high/urgent ones are
 *      retried on the next 15-minute tick (runOperatorTick), the rest wait for
 *      the digest.
 *
 * Titles are sent prefixed with the APP_URL host ("[app.example.com] …") so
 * alerts from staging and production can be told apart on one phone.
 *
 * It NEVER throws: an alert path that can take down the code it reports on is
 * worse than none. If even the database is unreachable, the alert is printed.
 *
 * NO CUSTOMER DATA in a title or body: on ntfy.sh it sits on a public server,
 * readable by anyone who learns the topic. Ids, counts and error classes only.
 */
import { db } from "@repo/db";
import { sendOperatorMail } from "@repo/email";
import { env } from "@repo/env";
import { deliver, type DeliveryResult } from "@repo/outbound";

import { operatorTopic, transmitPush, type PushMessage } from "./ntfy";
import {
  dueSlot,
  parseDigestTimes,
  renderDigest,
  type Priority,
} from "./policy";

export {
  PRIORITIES,
  dueSlot,
  parseDigestTimes,
  renderDigest,
  type Priority,
} from "./policy";

export interface OperatorNotification {
  /** One line. */
  title: string;
  /** A few short lines. No customer data (see the header). */
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

export type Status =
  | "pending"
  | "sent"
  | "logged"
  | "held"
  | "digested"
  | "deduped"
  | "blocked"
  | "failed";

export interface NotifyResult {
  /** The notification row, or null when even the database was unreachable. */
  id: string | null;
  status: Status;
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
/** Rows that mean "the operator has (or will get) this one". */
const REACHED: Status[] = ["sent", "logged", "held", "digested"];
/**
 * A pending row counts as in flight only this long after it was CLAIMED
 * (`claimedAt`; ntfy times out at 10s, SMTP at 30s). Within it, it suppresses
 * a repeat, or five simultaneous calls would all send. Past it, it is
 * abandoned (the sender crashed): it suppresses nothing, and a high/urgent one
 * is picked up again by retryCapHeld rather than stranded.
 */
const IN_FLIGHT_MS = 2 * MINUTE;
/** Why a send was held by the volume cap; the tick retries high/urgent ones. */
const CAP_HELD = "VOLUME";

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
            OR: [
              {
                status: { in: REACHED },
                createdAt: { gte: new Date(now.getTime() - windowMs) },
              },
              {
                status: "pending",
                claimedAt: { gte: new Date(now.getTime() - IN_FLIGHT_MS) },
              },
            ],
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
      const hold = n.priority === "low";
      return tx.notification.create({
        data: {
          ...data,
          status: hold ? "held" : "pending",
          claimedAt: hold ? null : now,
          error: hold ? "low priority waits for the digest" : null,
        },
        select: { id: true, status: true },
      });
    });

    if (row.status !== "pending") {
      log(row.status, n.priority, channel, title);
      return { id: row.id, status: row.status as Status, channel };
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

/** "[app.example.com] title": which deployment is talking. */
function withHost(title: string): string {
  try {
    return `[${new URL(env().APP_URL).host}] ${title}`;
  } catch {
    return title;
  }
}

/** Send one recorded notification and record the outcome. Never throws. */
async function dispatch(
  id: string,
  channel: Channel,
  msg: PushMessage,
  deps: NotifyDeps,
): Promise<Status> {
  let status: Status;
  let error: string | null = null;
  let outboundMessageId: string | null = null;
  const out = { ...msg, title: withHost(msg.title) };
  try {
    let result: DeliveryResult | null = null;
    if (channel === "console") {
      console.log(
        [
          "",
          `[notify] ── operator notification (${msg.priority}) — set NTFY_TOPIC or OPERATOR_EMAIL to receive these`,
          `[notify] ${out.title}`,
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
          subject: out.title,
          purpose: "operator.notify",
          operator: true,
        },
        // The guard passes the topic it checked; publish to that one.
        (topic) => transmitPush(topic, out, deps.fetch),
      );
    } else {
      result = await sendOperatorMail(
        {
          subject: `[${msg.priority}] ${out.title}`,
          text: [msg.body, msg.url].filter(Boolean).join("\n\n"),
        },
        "operator.notify",
      );
    }
    if (!result) status = "logged";
    else {
      outboundMessageId = result.id;
      if (result.status === "sent") status = "sent";
      else if (result.status === "in_progress") {
        // Not reachable: notify sends with no idempotencyKey. Kept honest.
        status = "pending";
        error = result.detail;
      } else {
        // Over the volume cap: not lost; retried by the tick or digested.
        status = result.reason === CAP_HELD ? "held" : "blocked";
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

/**
 * Re-send high/urgent notifications the volume cap held, instead of letting
 * them wait for a digest that may be a day away, and high/urgent ones whose
 * sender crashed mid-send (pending, claimed longer ago than IN_FLIGHT_MS).
 * Each row is claimed with a compare-and-set on (status, claimedAt) before it
 * is sent, so two workers cannot both send it. A crash after the provider
 * accepted means the operator may get that alert twice: for high/urgent, a
 * duplicate beats a lost alert.
 */
export async function retryCapHeld(deps: NotifyDeps = {}): Promise<number> {
  const channel = operatorChannel();
  const now = deps.now ?? new Date();
  const abandoned = new Date(now.getTime() - IN_FLIGHT_MS);
  const rows = await db.notification.findMany({
    where: {
      priority: { in: ["high", "urgent"] },
      OR: [
        { status: "held", error: { startsWith: CAP_HELD } },
        { status: "pending", claimedAt: { lt: abandoned } },
        // Pending since before claimedAt existed.
        { status: "pending", claimedAt: null, createdAt: { lt: abandoned } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      id: true,
      status: true,
      claimedAt: true,
      priority: true,
      title: true,
      body: true,
      url: true,
      tags: true,
    },
  });
  let retried = 0;
  for (const r of rows) {
    const claim = await db.notification.updateMany({
      where: { id: r.id, status: r.status, claimedAt: r.claimedAt },
      data: { status: "pending", channel, claimedAt: now },
    });
    if (!claim.count) continue;
    retried++;
    await dispatch(
      r.id,
      channel,
      {
        title: r.title,
        body: r.body,
        priority: r.priority as Priority,
        tags: r.tags,
        url: r.url,
      },
      deps,
    );
  }
  return retried;
}

const LAST_SLOT = "notify.digest.lastSlot";

export interface DigestResult {
  slot: string;
  /** Held notifications the digest carried (0 = nothing to send). */
  count: number;
  digestId: string | null;
  status: Status | null;
}

/**
 * Send the due digest, if a slot is due; null when none is. Claiming the slot
 * and the held rows happens in one transaction under an advisory lock, so two
 * workers cannot send the same digest. An empty slot is recorded and silent.
 * If the digest is not delivered (failed, blocked, over the cap), its items go
 * back to "held" for the next slot and the digest row is marked failed: a
 * digest is never itself held, or it would swallow its items.
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
    const digest = await tx.notification.create({
      data: {
        priority: "low",
        title: text.title,
        body: text.body,
        dedupeKey: `digest:${slot}`,
        channel,
        status: "pending",
        claimedAt: now,
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
  const digestId = claimed.digest.id;
  let status = await dispatch(
    digestId,
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
  if (status !== "sent" && status !== "logged") {
    status = "failed";
    await db
      .$transaction([
        db.notification.updateMany({
          where: { digestId, status: "digested" },
          data: { status: "held", digestId: null },
        }),
        db.notification.updateMany({
          where: { id: digestId },
          data: { status: "failed" },
        }),
      ])
      .catch((err: unknown) =>
        console.error(
          "[notify] digest not delivered AND its items could not be re-held:",
          err,
        ),
      );
  }
  return { slot: claimed.slot, count: claimed.count, digestId, status };
}

/**
 * The worker's 15-minute tick (`operator.digest` job): retry cap-held urgent
 * alerts, then send the digest if one is due.
 */
export async function runOperatorTick(deps: NotifyDeps = {}) {
  const retried = await retryCapHeld(deps);
  const digest = await runDigest(deps);
  return { retried, digest };
}
