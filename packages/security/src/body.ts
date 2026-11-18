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

export async function readBodyLimited(
  req: Request,
  maxBytes: number,
): Promise<LimitedBody> {
  const tooLarge: LimitedBody = {
    ok: false,
    status: 413,
    error: `Body larger than ${maxBytes} bytes`,
  };
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: true, text: "" };

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
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}
