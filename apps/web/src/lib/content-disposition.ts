/**
 * `inline` with an ASCII-only `filename` (header values must be Latin-1:
 * a name like "отчёт.pdf" or "見積.pdf" in a plain header throws, a 500) plus
 * the real name as RFC 5987 `filename*=UTF-8''<percent-encoded>`, which every
 * current browser prefers.
 */
export function contentDisposition(filename: string): string {
  const ascii =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\]/g, "")
      .trim() || "file";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
