/**
 * The tenant's inbox: messages that ARRIVED (packages/inbound), email and SMS.
 * Org-scoped like everything else: every `where` pins ctx.organizationId, and
 * the one write (handled / not handled) is an updateMany on id AND org, with
 * its audit event in the same transaction.
 *
 * The HTML of an email is never sent to the browser: the UI shows the text,
 * which the worker derives from the HTML when a mail had none.
 */
import { z } from "zod";
import { ensureEmailAddress } from "@repo/inbound";
import { env } from "@repo/env";
import { maskRecipient } from "@repo/outbound";
import { storage } from "@repo/storage";

import { DomainRuleError, NotFoundError } from "../errors";
import { createTRPCRouter, orgProcedure } from "../trpc";

interface AttachmentJson {
  filename: string;
  contentType: string;
  sizeBytes: number;
  mediaAssetId: string | null;
  skipped?: string;
}

function attachmentsOf(value: unknown): AttachmentJson[] {
  return Array.isArray(value) ? (value as AttachmentJson[]) : [];
}

export const inboxRouter = createTRPCRouter({
  list: orgProcedure
    .input(
      z
        .object({
          show: z.enum(["open", "all"]).default("open"),
          limit: z.number().int().min(1).max(100).default(50),
          /** createdAt of the last row of the previous page. */
          before: z.date().optional(),
        })
        .default({ show: "open", limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.inboundMessage.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.show === "open" ? { handledAt: null } : {}),
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          channel: true,
          fromAddress: true,
          toAddress: true,
          subject: true,
          snippet: true,
          status: true,
          attachments: true,
          handledAt: true,
          createdAt: true,
        },
      });
      return rows.map(({ attachments, ...r }) => ({
        ...r,
        attachmentCount: attachmentsOf(attachments).length,
      }));
    }),

  get: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.inboundMessage.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: {
          id: true,
          channel: true,
          fromAddress: true,
          toAddress: true,
          subject: true,
          text: true,
          status: true,
          error: true,
          attachments: true,
          handledAt: true,
          handledBy: { select: { name: true } },
          createdAt: true,
          processedAt: true,
          html: true,
          replyToOutbound: {
            select: {
              id: true,
              channel: true,
              recipient: true,
              subject: true,
              purpose: true,
              createdAt: true,
            },
          },
        },
      });
      if (!row) throw new NotFoundError("Message not found.");

      // Files come from the tenant's own media assets only.
      const list = attachmentsOf(row.attachments);
      const ids = list.flatMap((a) => (a.mediaAssetId ? [a.mediaAssetId] : []));
      const assets = ids.length
        ? await ctx.db.mediaAsset.findMany({
            where: { id: { in: ids }, organizationId: ctx.organizationId },
            select: { id: true, key: true },
          })
        : [];
      const driver = storage();
      const urls = new Map(
        await Promise.all(
          assets.map(async (a) => [a.id, await driver.url(a.key)] as const),
        ),
      );
      const { html, attachments: _raw, replyToOutbound, ...rest } = row;
      return {
        ...rest,
        // A reply's original recipient, as anyone may see it (push secrets masked).
        replyToOutbound: replyToOutbound && {
          ...replyToOutbound,
          recipient: maskRecipient(
            replyToOutbound.channel,
            replyToOutbound.recipient,
          ),
        },
        hasHtml: Boolean(html),
        attachments: list.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          skipped: a.skipped ?? null,
          url: (a.mediaAssetId && urls.get(a.mediaAssetId)) || null,
        })),
      };
    }),

  setHandled: orgProcedure
    .input(z.object({ id: z.string().min(1), handled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const { count } = await tx.inboundMessage.updateMany({
          where: { id: input.id, organizationId: ctx.organizationId },
          data: input.handled
            ? { handledAt: new Date(), handledById: ctx.user.id }
            : { handledAt: null, handledById: null },
        });
        if (count === 0) throw new NotFoundError("Message not found.");
        await ctx.audit(
          input.handled ? "inbound.handle" : "inbound.reopen",
          { targetType: "inbound_message", targetId: input.id },
          tx,
        );
        return { id: input.id, handled: input.handled };
      }),
    ),

  /** Where this tenant's messages can be sent. */
  addresses: orgProcedure.query(async ({ ctx }) => {
    const e = env();
    // The generated address (one per tenant); hand-added routes are not listed.
    const email = await ctx.db.inboundRoute.findUnique({
      where: { autoForOrg: ctx.organizationId },
      select: { address: true },
    });
    return {
      emailEnabled: Boolean(e.INBOUND_EMAIL_DOMAIN),
      email: email?.address ?? null,
      sms: e.OUTBOUND_SMS_ENABLED ? (e.TWILIO_FROM_NUMBER ?? null) : null,
    };
  }),

  /** Give this tenant its inbound email address (idempotent). */
  createEmailAddress: orgProcedure.mutation(({ ctx }) =>
    ctx.db.$transaction(async (tx) => {
      const address = await ensureEmailAddress(ctx.organizationId, tx);
      if (!address)
        throw new DomainRuleError(
          "Inbound email is not set up here (INBOUND_EMAIL_DOMAIN is unset).",
        );
      await ctx.audit(
        "inbound.address",
        { targetType: "inbound_route", targetId: address },
        tx,
      );
      return { address };
    }),
  ),
});
