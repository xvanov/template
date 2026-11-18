/**
 * Authenticated blob download for the local storage driver.
 *
 * The tenant check is the whole point: object keys are guessable enough that
 * serving `storage/` as static files would leak every tenant's uploads. The S3
 * driver bypasses this route entirely by handing out short-lived presigned
 * URLs.
 */
import { db } from "@repo/db";
import { storage } from "@repo/storage";

import { contentDisposition } from "@/lib/content-disposition";
import { requireTenant } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tenant = await requireTenant(req);
  if (!tenant.ok) {
    // No tenant (e.g. removed from their only org): the same 404 as a key that
    // does not exist, so nothing is confirmed about it.
    return tenant.status === 401
      ? new Response("Unauthorized", { status: 401 })
      : new Response("Not found", { status: 404 });
  }

  const key = new URL(req.url).searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  // Scoped to the ACTIVE tenant, like every org query (a user in two orgs
  // switches org to see the other's files). Same 404 for "absent"
  // and "someone else's" — a 403 here would confirm the key exists.
  const asset = await db.mediaAsset.findFirst({
    where: { key, organizationId: tenant.organizationId },
    select: {
      contentType: true,
      filename: true,
      sizeBytes: true,
    },
  });
  if (!asset) return new Response("Not found", { status: 404 });

  let bytes: Uint8Array;
  try {
    bytes = await storage().get(key);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(asset.filename),
      // Private: this URL is per-user authorised, so no shared cache may keep it.
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
