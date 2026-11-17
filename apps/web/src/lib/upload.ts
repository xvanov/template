/**
 * Browser-side upload to the authenticated, tenant-scoped /api/media/upload
 * route. File bytes cannot ride tRPC, which is why this is a plain fetch.
 * Throws an Error carrying the server's message on any non-2xx response.
 */
export async function uploadFile(file: File): Promise<{ id: string }> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/media/upload", { method: "POST", body });
  const payload = (await res.json().catch(() => null)) as {
    id?: string;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(payload?.error ?? `Upload failed (${res.status})`);
  }
  return { id: payload?.id ?? "" };
}
