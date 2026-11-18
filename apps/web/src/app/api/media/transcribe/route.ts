/**
 * Speech to text: a multipart `file` (audio) in, `{ text, seconds }` out.
 * Used by the mobile app's dictate button.
 *
 * A route, not tRPC, because the body is file bytes (docs/guide.md rule 1).
 * Same rules as an upload: signed in, tenant from the session, an audio
 * allow-list and size cap before a byte goes anywhere. The audio is NOT
 * stored: it goes to the transcription provider (packages/ai transcribe(),
 * priced into llm_call against the tenant's daily cap) and is dropped.
 */
import { transcribe } from "@repo/ai";
import {
  clientIp,
  rateLimit,
  readBytesLimited,
  tooManyRequests,
} from "@repo/security";
import {
  MAX_AUDIO_BYTES,
  assertAudioAllowed,
  normalizeAudioType,
} from "@repo/storage";

import { requireTenant } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/** What the user is told, by @repo/ai error name; anything else is a 502. */
const EXPECTED: Record<string, { status: number; error: string }> = {
  LlmDisabledError: {
    status: 503,
    error: "Transcription is not set up on this server.",
  },
  LlmConfigError: {
    status: 503,
    error: "Transcription is misconfigured on this server.",
  },
  LlmUnpricedError: {
    status: 503,
    error:
      "Transcription has no price configured, so the daily AI budget cannot allow it.",
  },
  LlmBudgetExceededError: {
    status: 429,
    error: "Today's AI budget for this workspace is used up.",
  },
};

export async function POST(req: Request) {
  const tenant = await requireTenant(req);
  if (!tenant.ok) {
    return Response.json(
      {
        error:
          tenant.status === 401
            ? "Sign in required."
            : "No organization for this user.",
      },
      { status: tenant.status },
    );
  }
  const { organizationId, userId } = tenant;

  // Each call costs money: throttle per user. Fails open like the tRPC
  // limiter (the daily cap still bounds spend).
  try {
    const r = await rateLimit({
      key: `media:transcribe:user:${userId}`,
      limit: 20,
      windowSeconds: 60,
    });
    if (!r.allowed) return tooManyRequests(r);
  } catch (err) {
    console.warn(
      `[media] rate limiter unavailable (${clientIp(req.headers) ?? "?"}), allowing:`,
      err,
    );
  }

  // Streamed with a hard cap (the multipart framing on top of the largest
  // allowed file): a chunked body with no Content-Length cannot make us
  // buffer more than that.
  const body = await readBytesLimited(req, MAX_AUDIO_BYTES + 64 * 1024);
  if (!body.ok) return tooLarge();

  let file: File | null = null;
  let language: string | undefined;
  try {
    const form = await new Response(body.bytes as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
    const lang = form.get("language");
    if (typeof lang === "string" && /^[a-z]{2}$/.test(lang)) language = lang;
  } catch {
    return Response.json(
      { error: "Malformed multipart body." },
      { status: 400 },
    );
  }
  if (!file) {
    return Response.json({ error: "Missing `file` field." }, { status: 400 });
  }

  const contentType = normalizeAudioType(file.type || "");
  if (file.size > MAX_AUDIO_BYTES) return tooLarge();
  try {
    assertAudioAllowed(contentType, file.size);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Rejected." },
      { status: 415 },
    );
  }

  try {
    const r = await transcribe({
      purpose: "media.dictate",
      // A convenience: stops at the tenant's daily cap.
      priority: "discretionary",
      organizationId,
      userId,
      audio: new Uint8Array(await file.arrayBuffer()),
      filename: file.name || "recording.m4a",
      contentType,
      language,
    });
    return Response.json({ text: r.text, seconds: r.seconds });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const known = EXPECTED[name];
    if (known) {
      return Response.json({ error: known.error }, { status: known.status });
    }
    console.error("[media] transcription failed:", err);
    return Response.json(
      { error: "Transcription failed. Try again." },
      { status: 502 },
    );
  }
}

function tooLarge(): Response {
  return Response.json(
    {
      error: `Recording too large (max ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB).`,
    },
    { status: 413 },
  );
}
