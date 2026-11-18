/**
 * Mobile push devices: the app registers its Expo push token here after
 * sign-in (and on every start, as a heartbeat), and unregisters it on
 * sign-out. Sending is @repo/push-mobile's, through the outbound guard.
 *
 * Ownership: a token names one app install, so it is unique across the
 * whole table. Registering a token held by someone else (another user, or
 * you in another org) TAKES IT OVER: the phone changed hands, or the user
 * switched organization, and pushes must follow whoever is signed in on it
 * now. That is the one write here not filtered by the caller's org, on
 * purpose: possessing the token (it is read from the device itself) is the
 * proof. Everything else (list, unregister) is scoped to this org and user.
 *
 * Audit: a NEW registration or a takeover is audited; the per-start
 * heartbeat on an already-owned token only bumps lastSeenAt (auditing every
 * app launch would bury the trail).
 */
import { z } from "zod";
import { parseRecipient } from "@repo/outbound";
import { mobilePushEnabled, sendMobilePush } from "@repo/push-mobile";

import { DomainRuleError } from "../errors";
import { ForbiddenError } from "../errors"; // @module:agent
import { createTRPCRouter, orgProcedure, rateLimited } from "../trpc";

const tokenInput = z
  .string()
  .trim()
  .max(256)
  .transform((t, ctx) => {
    const parsed = parseRecipient("mobile_push", t);
    if (!parsed) {
      ctx.addIssue({
        code: "custom",
        message: "Not an Expo push token (ExponentPushToken[...]).",
      });
      return z.NEVER;
    }
    return parsed;
  });

/** What the app may see of a token: enough to tell devices apart. */
function preview(token: string): string {
  const open = token.indexOf("[");
  return `${token.slice(0, open + 5)}…]`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export const pushRouter = createTRPCRouter({
  /** Is mobile push switched on server-side (OUTBOUND_MOBILE_PUSH_ENABLED)? */
  status: orgProcedure.query(() => ({ enabled: mobilePushEnabled() })),

  register: orgProcedure
    .use(rateLimited({ limit: 20, windowSeconds: 60 }))
    .input(
      z.object({
        token: tokenInput,
        platform: z.enum(["ios", "android"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // @module:agent
      if (ctx.apiKey)
        throw new ForbiddenError("Devices are registered from the app.");
      // @end
      const mine = {
        token: input.token,
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
      };
      // Heartbeat: already ours here. Re-enables it (a reinstall that kept
      // the token, or a disable we no longer agree with).
      const refreshed = await ctx.db.pushDevice.updateMany({
        where: mine,
        data: {
          platform: input.platform,
          disabled: false,
          disabledReason: null,
          lastSeenAt: new Date(),
        },
      });
      if (refreshed.count) return { registered: true, takeover: false };

      const write = () =>
        ctx.db.$transaction(async (tx) => {
          // Someone else's row for this token (see the header): it moves.
          const { count: taken } = await tx.pushDevice.deleteMany({
            where: { token: input.token },
          });
          const device = await tx.pushDevice.create({
            data: { ...mine, platform: input.platform },
            select: { id: true },
          });
          await ctx.audit(
            "push_device.register",
            {
              targetId: device.id,
              metadata: { platform: input.platform, takeover: taken > 0 },
            },
            tx,
          );
          return { registered: true, takeover: taken > 0 };
        });
      try {
        return await write();
      } catch (err) {
        // Two registrations of one token raced (app start + permission
        // grant): the other one created it; take it over once more.
        if (!isUniqueViolation(err)) throw err;
        return write();
      }
    }),

  /** Sign-out: this device stops getting this user's pushes. */
  unregister: orgProcedure
    .input(z.object({ token: tokenInput }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const devices = await tx.pushDevice.findMany({
          where: {
            token: input.token,
            organizationId: ctx.organizationId,
            userId: ctx.user.id,
          },
          select: { id: true },
        });
        const { count } = await tx.pushDevice.deleteMany({
          where: {
            token: input.token,
            organizationId: ctx.organizationId,
            userId: ctx.user.id,
          },
        });
        for (const d of devices) {
          await ctx.audit("push_device.unregister", { targetId: d.id }, tx);
        }
        return { removed: count };
      }),
    ),

  /** Your devices in this organization. */
  devices: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.pushDevice.findMany({
      where: { organizationId: ctx.organizationId, userId: ctx.user.id },
      orderBy: { lastSeenAt: "desc" },
      select: {
        id: true,
        token: true,
        platform: true,
        disabled: true,
        disabledReason: true,
        lastSeenAt: true,
      },
    });
    return rows.map(({ token, ...d }) => ({ ...d, token: preview(token) }));
  }),

  /**
   * Send yourself a test push, through the guard like any other (so safe
   * mode, caps and the log apply). Says what happened per device.
   */
  test: orgProcedure
    .use(rateLimited({ limit: 5, windowSeconds: 60 }))
    .mutation(async ({ ctx }) => {
      if (!mobilePushEnabled()) {
        throw new DomainRuleError(
          "Mobile push is off on the server (OUTBOUND_MOBILE_PUSH_ENABLED).",
        );
      }
      return sendMobilePush(
        { userId: ctx.user.id, organizationId: ctx.organizationId },
        {
          title: "Test notification",
          body: "Push notifications work on this device.",
          data: { kind: "test" },
        },
        { purpose: "push.test", actorUserId: ctx.user.id },
      );
    }),
});
