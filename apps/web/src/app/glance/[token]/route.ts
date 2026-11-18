/**
 * GET /glance/<gl_ secret>: a glanceable, read-only "what needs me" page for
 * Meta Ray-Ban Display glasses (installed there as a Web App; see
 * apps/mobile/modules/glasses/README.md). Also fine in any browser.
 *
 * A route handler, not a page or tRPC (CLAUDE.md rule 1): the caller is
 * authenticated by a secret in the URL, not a session, because typing a
 * password on the glasses is impractical. The secret is a glance link
 * (packages/api/src/glance.ts): it can read this snapshot and nothing else,
 * is revocable, and dies with its creator's membership. It is plain HTML with
 * one inline script, no framework bundle: the glasses' link is slow.
 *
 * Rate limited per link, and failed lookups per IP; both fail open if Redis
 * is down (they protect our capacity, like the tRPC throttle).
 */
import { randomBytes } from "node:crypto";
import { authenticateGlanceLink, glanceSnapshot } from "@repo/api";
import { db } from "@repo/db";
import { clientIp, rateLimit, tooManyRequests } from "@repo/security";

import manifest from "@/app/manifest";
import { renderGlanceGone, renderGlancePage } from "@/lib/glance-html";

export const dynamic = "force-dynamic";

/** The secret is in the URL: keep it out of referrers, caches and indexes. */
function headers(nonce: string | null): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

async function throttle(key: string, limit: number) {
  try {
    const r = await rateLimit({ key, limit, windowSeconds: 60 });
    return r.allowed ? null : tooManyRequests(r);
  } catch (err) {
    console.warn(
      `[glance] rate limiter unavailable for ${key}, allowing:`,
      err,
    );
    return null;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const appName = manifest().name ?? "App";
  const { token } = await params;
  const principal = await authenticateGlanceLink(db, token);
  if (!principal) {
    const ip = clientIp(req.headers) ?? "unknown";
    return (
      (await throttle(`glance:unauthorized:${ip}`, 30)) ??
      new Response(renderGlanceGone(appName), {
        status: 404,
        headers: headers(null),
      })
    );
  }
  const limited = await throttle(`glance:link:${principal.linkId}`, 30);
  if (limited) return limited;

  const nonce = randomBytes(16).toString("base64");
  const snapshot = await glanceSnapshot(db, principal.organizationId);
  return new Response(renderGlancePage({ snapshot, appName, nonce }), {
    headers: headers(nonce),
  });
}
