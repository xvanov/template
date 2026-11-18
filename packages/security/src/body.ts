/**
 * Read a request body with a hard byte cap, BEFORE any signature work.
 *
 * `req.text()` buffers whatever arrives: a chunked upload with no
 * Content-Length is unbounded, and an unauthenticated caller can make every
 * webhook allocate and HMAC hundreds of megabytes. This refuses on the
 * declared length first, then counts bytes as they stream and stops reading
 * the moment the cap is passed.
 */
export type LimitedBody =
  { ok: true; text: string } | { ok: false; status: 413; error: string };

export type LimitedBytes =
  { ok: true; bytes: Uint8Array } | { ok: false; status: 413; error: string };

/** The body as bytes (file uploads), with the same cap and streaming rules. */
export async function readBytesLimited(
  req: Request,
  maxBytes: number,
): Promise<LimitedBytes> {
  const tooLarge = {
    ok: false as const,
    status: 413 as const,
    error: `Body larger than ${maxBytes} bytes`,
  };
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: true, bytes: new Uint8Array() };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge;
    }
    chunks.push(value);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** The body as UTF-8 text (webhooks). */
export async function readBodyLimited(
  req: Request,
  maxBytes: number,
): Promise<LimitedBody> {
  const r = await readBytesLimited(req, maxBytes);
  return r.ok ? { ok: true, text: Buffer.from(r.bytes).toString("utf8") } : r;
}
