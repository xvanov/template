/**
 * Mobile push to the app (Expo push → APNs/FCM), behind the outbound guard.
 * OFF by default: OUTBOUND_MOBILE_PUSH_ENABLED=true turns the channel on.
 *
 *   await sendMobilePush(
 *     { userId, organizationId },
 *     { title: "Waiting for your approval", body: "Open the app to review it." },
 *     { purpose: "agent.proposal", idempotencyKey: `proposal:${id}` },
 *   );
 *
 * One guarded message PER DEVICE (the recipient the guard checks, caps and
 * logs is the device's Expo push token); the transport batches them into one
 * Expo request.
 *
 * Safe mode: Expo push has no catcher, so OUTBOUND_SAFE_MODE=local means
 * STRICT here. A device passes strict mode if OUTBOUND_SAFE_RECIPIENTS lists
 * its exact token, or its owner's VERIFIED email (or @domain); the guard
 * looks the owner up itself (see RecipientFacts in @repo/outbound).
 *
 * NO CUSTOMER DATA in a title or body. A push is shown on the lock screen and
 * travels through Expo's and Apple's/Google's servers; say THAT something
 * happened ("New email"), never who or what. Same decision as the desktop
 * shell's default. `data` carries ids only, for the app to fetch the rest
 * over the authenticated API.
 *
 * The raw transport lives in ./transport.ts and is not exported.
 */
import { db } from "@repo/db";
import { env } from "@repo/env";
import { deliver, recordDeliveryStatus } from "@repo/outbound";

import {
  DeviceNotRegisteredError,
  fetchReceipts,
  transmit,
  useFakeExpoFetch,
} from "./transport";

export {
  /** Tests only: Expo's HTTP calls go to this fake (the network is refused under test). */
  useFakeExpoFetch,
};

export interface MobilePush {
  /** One short line. No customer data (see the header). */
  title: string;
  body: string;
  /** Ids only. Delivered to the app, not shown. */
  data?: Record<string, string>;
}

export interface MobilePushContext {
  /** What is sending it, dotted: `agent.proposal`. */
  purpose: string;
  /**
   * Stable name of this one logical push. Each device's message gets
   * `<key>:<deviceId>`, so a retried job sends nothing twice to a device
   * that already got it (see `idempotencyKey` in @repo/outbound).
   */
  idempotencyKey?: string;
  actorUserId?: string | null;
}

export interface PushOutcome {
  devices: number;
  sent: number;
  blocked: number;
  /** Devices found to be uninstalled and disabled by this send. */
  disabled: number;
}

export function mobilePushEnabled(): boolean {
  return env().OUTBOUND_MOBILE_PUSH_ENABLED;
}

/**
 * Push to every enabled device a user registered in this organization, if
 * they are still a member of it. Resolves with counts; throws only if some
 * device's send failed for a reason worth retrying (after trying them all),
 * so a job retries and the idempotency keys skip the devices that got it.
 */
export async function sendMobilePush(
  to: { userId: string; organizationId: string },
  push: MobilePush,
  ctx: MobilePushContext,
): Promise<PushOutcome> {
  const devices = await db.pushDevice.findMany({
    where: {
      organizationId: to.organizationId,
      userId: to.userId,
      disabled: false,
      // Removed from the org since registering: no more of its news.
      user: { members: { some: { organizationId: to.organizationId } } },
    },
    select: { id: true, token: true },
  });
  const outcome: PushOutcome = {
    devices: devices.length,
    sent: 0,
    blocked: 0,
    disabled: 0,
  };
  const results = await Promise.allSettled(
    devices.map((d) =>
      deliver(
        {
          channel: "mobile_push",
          recipient: d.token,
          purpose: ctx.purpose,
          organizationId: to.organizationId,
          actorUserId: ctx.actorUserId,
          subject: push.title.slice(0, 80),
          ...(ctx.idempotencyKey
            ? { idempotencyKey: `${ctx.idempotencyKey}:${d.id}` }
            : {}),
        },
        (token, meta) =>
          transmit(
            token,
            {
              title: push.title.slice(0, 100),
              body: push.body.slice(0, 200),
              data: push.data,
              sound: "default",
              priority: "high",
              channelId: "default",
            },
            meta,
          ),
      ),
    ),
  );
  let retryable: unknown;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.status === "sent") outcome.sent++;
      else if (r.value.status === "blocked") outcome.blocked++;
    } else if (r.reason instanceof DeviceNotRegisteredError) {
      outcome.disabled += await disableDevice(
        r.reason.token,
        "DeviceNotRegistered",
      );
    } else {
      retryable ??= r.reason;
    }
  }
  if (retryable) throw retryable;
  return outcome;
}

/** Stop sending to a token (the app is gone). Returns rows changed. */
export async function disableDevice(
  token: string,
  reason: string,
): Promise<number> {
  const { count } = await db.pushDevice.updateMany({
    where: { token, disabled: false },
    data: { disabled: true, disabledReason: reason.slice(0, 200) },
  });
  if (count)
    console.warn(
      `[push-mobile] disabled a device (${reason}): ${token.slice(0, 22)}…`,
    );
  return count;
}

/**
 * Step two of Expo delivery: ask for the receipts of pushes sent 15 minutes
 * to 23 hours ago that have none recorded yet (Expo keeps receipts about a
 * day), record each on its outbound_message row, and disable devices Expo
 * reports as DeviceNotRegistered. Run by the worker (push.receipts). A no-op
 * while the channel is off.
 */
export async function checkMobilePushReceipts(
  opts: { limit?: number; now?: Date } = {},
): Promise<{ checked: number; ok: number; errors: number; disabled: number }> {
  const result = { checked: 0, ok: 0, errors: 0, disabled: 0 };
  if (!mobilePushEnabled()) return result;
  const now = opts.now ?? new Date();
  const rows = await db.outboundMessage.findMany({
    where: {
      channel: "mobile_push",
      status: "sent",
      providerMessageId: { not: null },
      deliveryStatus: null,
      createdAt: {
        gte: new Date(now.getTime() - 23 * 3_600_000),
        lte: new Date(now.getTime() - 15 * 60_000),
      },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 1000,
    select: { providerMessageId: true, recipient: true },
  });
  if (!rows.length) return result;
  const receipts = await fetchReceipts(rows.map((r) => r.providerMessageId!));
  for (const row of rows) {
    const id = row.providerMessageId!;
    const receipt = receipts[id];
    if (!receipt) continue; // not ready yet: next run
    result.checked++;
    if (receipt.status === "ok") {
      result.ok++;
      // "sent", not "delivered": Expo only knows APNs/FCM accepted it.
      await recordDeliveryStatus({
        channel: "mobile_push",
        providerMessageId: id,
        status: "sent",
        detail: "accepted by APNs/FCM",
      });
      continue;
    }
    result.errors++;
    const code = receipt.details?.error;
    await recordDeliveryStatus({
      channel: "mobile_push",
      providerMessageId: id,
      status: code === "DeviceNotRegistered" ? "undelivered" : "failed",
      detail: `${code ?? "error"}: ${receipt.message}`,
    });
    if (code === "DeviceNotRegistered") {
      result.disabled += await disableDevice(row.recipient, code);
    } else if (code === "InvalidCredentials") {
      console.error(
        "[push-mobile] Expo reports InvalidCredentials: the app's APNs key or FCM credentials are missing or wrong in EAS (eas credentials).",
      );
    }
  }
  return result;
}

// ── what the app pushes about ─────────────────────────────────────────────

/** Things in a tenant that want a human, as pushes. Same set as desktop.feed. */
export type AppEvent =
  { kind: "proposal"; id: string } | { kind: "inbound"; id: string };

/**
 * The lock-screen text for an event: what happened, never who or what (see
 * the header). Pure, so the "no customer data" rule is a unit test.
 */
export function pushText(
  event: AppEvent,
  detail: { channel?: string } = {},
): MobilePush {
  if (event.kind === "proposal") {
    return {
      title: "Waiting for your approval",
      body: "An agent proposal needs your review.",
      data: { kind: event.kind, id: event.id },
    };
  }
  return {
    title: detail.channel === "sms" ? "New text message" : "New email",
    body: "Open the app to read it.",
    data: { kind: event.kind, id: event.id },
  };
}

/** Members of an org who should hear about a proposal no one in particular asked for. */
async function orgAdmins(organizationId: string): Promise<string[]> {
  const members = await db.member.findMany({
    where: { organizationId, role: { in: ["owner", "admin"] } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

/**
 * Push one event to the people it concerns:
 *   proposal  the user it was made for (proposedBy), else the org's owners
 *             and admins; only while it is still pending.
 *   inbound   every member of the org with a registered device.
 * Idempotent per event and device. A no-op while the channel is off.
 */
export async function notifyAppEvent(
  organizationId: string,
  event: AppEvent,
): Promise<PushOutcome & { users: number; skipped?: string }> {
  const none = { users: 0, devices: 0, sent: 0, blocked: 0, disabled: 0 };
  if (!mobilePushEnabled())
    return { ...none, skipped: "OUTBOUND_MOBILE_PUSH_ENABLED is off" };

  let users: string[];
  let push: MobilePush;
  if (event.kind === "proposal") {
    const p = await db.agentProposal.findFirst({
      where: { id: event.id, organizationId },
      select: { status: true, proposedById: true },
    });
    if (!p || p.status !== "pending")
      return { ...none, skipped: "not pending" };
    users = p.proposedById ? [p.proposedById] : await orgAdmins(organizationId);
    push = pushText(event);
  } else {
    const m = await db.inboundMessage.findFirst({
      where: { id: event.id, organizationId },
      select: { channel: true },
    });
    if (!m) return { ...none, skipped: "not found" };
    const devices = await db.pushDevice.findMany({
      where: { organizationId, disabled: false },
      distinct: ["userId"],
      select: { userId: true },
    });
    users = devices.map((d) => d.userId);
    push = pushText(event, { channel: m.channel });
  }

  const total = { ...none, users: users.length };
  let failure: unknown;
  for (const userId of users) {
    try {
      const r = await sendMobilePush({ userId, organizationId }, push, {
        purpose: `push.${event.kind}`,
        idempotencyKey: `push:${event.kind}:${event.id}`,
      });
      total.devices += r.devices;
      total.sent += r.sent;
      total.blocked += r.blocked;
      total.disabled += r.disabled;
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return total;
}
