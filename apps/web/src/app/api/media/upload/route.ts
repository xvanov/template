/**
 * Multipart upload. tRPC is the wrong transport for file bodies, so uploads get
 * a plain route — but the same rules apply: authenticated, tenant-scoped, and
 * validated against a content-type allow-list before a byte is written.
 */
import { auth } from "@repo/auth";
import { db } from "@repo/db";
import {
  MAX_UPLOAD_BYTES,
  assertUploadAllowed,
  buildKey,
  storage,
} from "@repo/storage";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }

  const organizationId =
    session.session.activeOrganizationId ??
    (
      await db.member.findFirst({
        where: { userId: session.user.id },
        orderBy: { createdAt: "asc" },
        select: { organizationId: true },
      })
    )?.organizationId;

  if (!organizationId) {
    return Response.json(
      { error: "No organization for this user." },
      { status: 403 },
    );
  }

  // Reject oversized bodies from the header before reading them into memory.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES * 1.1) {
    return Response.json({ error: "File too large." }, { status: 413 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return Response.json(
      { error: "Malformed multipart body." },
      { status: 400 },
    );
  }
  if (!file) {
    return Response.json({ error: "Missing `file` field." }, { status: 400 });
  }

  const contentType = file.type || "application/octet-stream";
  try {
    assertUploadAllowed(contentType, file.size);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Rejected." },
      { status: 415 },
    );
  }

  const key = buildKey(organizationId, file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await storage().put(key, bytes, contentType);

  const asset = await db.mediaAsset.create({
    data: {
      organizationId,
      key,
      filename: file.name.slice(0, 200),
      contentType,
      sizeBytes: bytes.byteLength,
      uploadedById: session.user.id,
    },
    select: {
      id: true,
      key: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
    },
  });

  return Response.json(
    { ...asset, url: await storage().url(asset.key) },
    { status: 201 },
  );
}
