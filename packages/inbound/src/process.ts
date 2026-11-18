/**
 * The worker half of an inbound message (job `inbound.process`): turn the
 * "received" row the webhook stored into a readable message.
 *
 *   1. the content: fetched from Resend (its webhook carries only metadata),
 *      or taken from what the generic webhook / Twilio posted;
 *   2. attachments → packages/storage + media_asset rows, at deterministic
 *      keys, so a retried job overwrites rather than duplicates. Only the
 *      content types the upload route accepts are stored (the blob route
 *      serves files from our own origin); the rest are listed as skipped;
 *   3. the thread: the outbound message it answers, matched only within the
 *      same tenant (a forged References header cannot reach across);
 *   4. a text body: derived from the HTML when the mail had none. The HTML
 *      is kept as received and never rendered by the app.
 *
 * Expected problems (an attachment too large, a provider that lost a media
 * file) are recorded on the row, not thrown. Unexpected ones throw: the job
 * retries, and `markInboundFailed` records the final failure.
 */
import { db, Prisma } from "@repo/db";
import { downloadReceivedAttachment, fetchReceivedEmail } from "@repo/email";
import { downloadMedia } from "@repo/sms";
import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  storage,
} from "@repo/storage";
import { z } from "zod";

import { SMS_REPLY_WINDOW_DAYS } from "./routing";
import { cleanFilename, htmlToText, messageIds, outboundIdsIn } from "./text";

export const MAX_ATTACHMENTS = 10;
const MAX_TEXT = 200_000;
const MAX_HTML = 500_000;

export interface AttachmentRecord {
  filename: string;
  contentType: string;
  sizeBytes: number;
  mediaAssetId: string | null;
  /** Why it was not stored, when it was not. */
  skipped?: string;
}

/** What a provider's payload becomes before it is stored. */
interface Content {
  subject: string | null;
  text: string | null;
  html: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: {
    filename: string;
    contentType: string;
    sizeBytes: number | null;
    load: () => Promise<Uint8Array>;
  }[];
}

/** The generic inbound webhook's body (also its documentation). */
export const genericInboundEmail = z.object({
  /** The sender's unique id for this message: the dedupe key. */
  id: z.string().min(1).max(200),
  from: z.string().min(1).max(500),
  to: z.array(z.string().max(500)).min(1).max(50),
  subject: z.string().max(2000).optional(),
  text: z.string().max(2_000_000).optional(),
  html: z.string().max(5_000_000).optional(),
  messageId: z.string().max(1000).optional(),
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(100).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().max(500).optional(),
        contentType: z.string().max(200),
        /** Base64. */
        content: z.string(),
      }),
    )
    .max(50)
    .optional(),
});
export type GenericInboundEmail = z.infer<typeof genericInboundEmail>;

async function contentOf(row: {
  provider: string;
  raw: Prisma.JsonValue;
}): Promise<Content> {
  const raw = (row.raw ?? {}) as Record<string, unknown>;
  switch (row.provider) {
    case "resend": {
      const m = await fetchReceivedEmail(String(raw.emailId));
      return {
        subject: m.subject,
        text: m.text,
        html: m.html,
        messageIdHeader: m.messageIdHeader,
        inReplyTo: m.inReplyTo,
        references: m.references,
        attachments: m.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          load: () =>
            a.downloadUrl
              ? downloadReceivedAttachment(a.downloadUrl, MAX_UPLOAD_BYTES)
              : Promise.reject(new Error("no download URL")),
        })),
      };
    }
    case "generic": {
      const m = genericInboundEmail.parse(raw);
      return {
        subject: m.subject ?? null,
        text: m.text ?? null,
        html: m.html ?? null,
        messageIdHeader: m.messageId ?? null,
        inReplyTo: m.inReplyTo ?? null,
        references: m.references ?? [],
        attachments: (m.attachments ?? []).map((a) => ({
          filename: a.filename ?? "attachment",
          contentType: a.contentType,
          sizeBytes: Math.floor((a.content.length * 3) / 4),
          load: async () => new Uint8Array(Buffer.from(a.content, "base64")),
        })),
      };
    }
    case "twilio": {
      const p = (raw.params ?? {}) as Record<string, string>;
      const count = Math.min(Number(p.NumMedia ?? 0) || 0, MAX_ATTACHMENTS);
      return {
        subject: null,
        text: p.Body ?? "",
        html: null,
        messageIdHeader: null,
        inReplyTo: null,
        references: [],
        attachments: Array.from({ length: count }, (_, i) => ({
          filename: `media-${i + 1}`,
          contentType: p[`MediaContentType${i}`] ?? "application/octet-stream",
          sizeBytes: null,
          load: async () =>
            (await downloadMedia(p[`MediaUrl${i}`] ?? "", MAX_UPLOAD_BYTES))
              .bytes,
        })),
      };
    }
    default:
      throw new Error(`Unknown inbound provider: ${row.provider}`);
  }
}

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

async function storeAttachments(
  organizationId: string,
  inboundId: string,
  list: Content["attachments"],
): Promise<AttachmentRecord[]> {
  const out: AttachmentRecord[] = [];
  for (const [i, a] of list.entries()) {
    const contentType = a.contentType.split(";")[0]!.trim().toLowerCase();
    const filename = cleanFilename(a.filename);
    const rec = (sizeBytes: number, skipped?: string): AttachmentRecord => ({
      filename,
      contentType,
      sizeBytes,
      mediaAssetId: null,
      ...(skipped ? { skipped } : {}),
    });
    if (i >= MAX_ATTACHMENTS) {
      out.push(
        rec(a.sizeBytes ?? 0, `more than ${MAX_ATTACHMENTS} attachments`),
      );
      continue;
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      out.push(rec(a.sizeBytes ?? 0, "file type not accepted"));
      continue;
    }
    if (a.sizeBytes !== null && a.sizeBytes > MAX_UPLOAD_BYTES) {
      out.push(rec(a.sizeBytes, "too large"));
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await a.load();
    } catch (err) {
      out.push(
        rec(
          a.sizeBytes ?? 0,
          `could not be fetched: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200,
          ),
        ),
      );
      continue;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
      out.push(rec(bytes.byteLength, "empty or too large"));
      continue;
    }
    // Deterministic: a retried job overwrites the same object and row.
    const key = `org/${organizationId}/inbound/${inboundId}/${i}${EXT[contentType] ?? ""}`;
    await storage().put(key, bytes, contentType);
    const asset = await db.mediaAsset.upsert({
      where: { key },
      create: {
        organizationId,
        key,
        filename,
        contentType,
        sizeBytes: bytes.byteLength,
        uploadedById: null,
      },
      update: { filename, contentType, sizeBytes: bytes.byteLength },
      select: { id: true },
    });
    out.push({ ...rec(bytes.byteLength), mediaAssetId: asset.id });
  }
  return out;
}

/** The outbound message this one answers, within the same tenant. */
async function threadOf(
  organizationId: string,
  channel: string,
  from: string,
  content: Content,
): Promise<string | null> {
  if (channel === "sms") {
    const last = await db.outboundMessage.findFirst({
      where: {
        organizationId,
        channel: "sms",
        recipient: from,
        status: "sent",
        createdAt: {
          gte: new Date(Date.now() - SMS_REPLY_WINDOW_DAYS * 86_400_000),
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return last?.id ?? null;
  }
  const ids = messageIds(content.inReplyTo, content.references);
  if (ids.length === 0) return null;
  const hit = await db.outboundMessage.findFirst({
    where: {
      organizationId,
      channel: "email",
      OR: [
        { id: { in: outboundIdsIn(ids) } },
        // SMTP providers report the Message-ID itself as the provider id.
        { providerMessageId: { in: ids } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return hit?.id ?? null;
}

export async function processInbound(payload: {
  organizationId: string;
  inboundMessageId: string;
}): Promise<{ status: string; attachments?: number; threaded?: boolean }> {
  const row = await db.inboundMessage.findFirst({
    where: {
      id: payload.inboundMessageId,
      organizationId: payload.organizationId,
    },
    select: {
      id: true,
      organizationId: true,
      channel: true,
      provider: true,
      fromAddress: true,
      subject: true,
      status: true,
      raw: true,
    },
  });
  if (!row) return { status: "gone" };
  if (row.status === "processed") return { status: "already processed" };

  const content = await contentOf(row);
  const attachments = await storeAttachments(
    row.organizationId,
    row.id,
    content.attachments,
  );
  const replyToOutboundId = await threadOf(
    row.organizationId,
    row.channel,
    row.fromAddress,
    content,
  );
  const text = content.text ?? (content.html ? htmlToText(content.html) : null);

  await db.inboundMessage.updateMany({
    where: { id: row.id, organizationId: row.organizationId },
    data: {
      status: "processed",
      error: null,
      subject: (content.subject ?? row.subject)?.slice(0, 500) ?? null,
      text: text?.slice(0, MAX_TEXT) ?? null,
      snippet: text ? text.replace(/\s+/g, " ").trim().slice(0, 200) : null,
      html: content.html?.slice(0, MAX_HTML) ?? null,
      messageIdHeader: content.messageIdHeader?.slice(0, 1000) ?? null,
      inReplyTo: content.inReplyTo?.slice(0, 1000) ?? null,
      attachments: attachments as unknown as Prisma.InputJsonValue,
      replyToOutboundId,
      // The provider payload has served its purpose (and may hold base64
      // attachments): drop it.
      raw: Prisma.DbNull,
      processedAt: new Date(),
    },
  });
  return {
    status: "processed",
    attachments: attachments.filter((a) => a.mediaAssetId).length,
    threaded: Boolean(replyToOutboundId),
  };
}

/** The job's final failure: the row must not stay "received" forever. */
export async function markInboundFailed(
  payload: { organizationId: string; inboundMessageId: string },
  err: Error,
): Promise<void> {
  await db.inboundMessage
    .updateMany({
      where: {
        id: payload.inboundMessageId,
        organizationId: payload.organizationId,
        status: "received",
      },
      data: { status: "failed", error: err.message.slice(0, 1000) },
    })
    .catch((e) => console.error("[inbound] could not mark failed:", e));
}
