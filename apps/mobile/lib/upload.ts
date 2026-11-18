/**
 * File bytes to the server's /api/media/* routes (CLAUDE.md rule 1), with
 * progress. The session cookie goes along by hand: React Native has no
 * cookie jar (same as the tRPC link in app/_layout.tsx).
 *
 *   const asset = await uploadMedia(photo, { onProgress: setProgress });
 *   const { text } = await transcribeAudio(recording);
 *
 * Native: expo-file-system's upload task. It streams the file from disk in
 * native code (no copy of a 10 MB photo in JS memory), reports progress, and
 * never builds a JS FormData, so the expo/fetch FormData bug described in
 * ./upload-body.ts cannot happen. The server sees the file's own name (the
 * task sends it); only the content type is ours. Web: the browser's fetch
 * with a FormData; the part comes from formDataPart, appended as a Blob.
 */
import { File, UploadType } from "expo-file-system";
import { Platform } from "react-native";

import { getBaseUrl } from "./api-url";
import { getSessionCookie } from "./auth";
import {
  formDataPart,
  parseUploadResponse,
  uploadType,
  type LocalFile,
} from "./upload-body";

export type { LocalFile } from "./upload-body";
export { UploadError } from "./upload-body";

export interface UploadOptions {
  /** 0..1. Native only; web reports 0 then 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Extra multipart fields. */
  fields?: Record<string, string>;
  /** Content type when the file says nothing and its name has no extension. */
  fallbackType?: string;
}

export interface MediaAsset {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

function cookieHeader(): Record<string, string> {
  const cookie = getSessionCookie();
  return cookie ? { Cookie: cookie } : {};
}

async function postFile<T>(
  path: string,
  file: LocalFile,
  opts: UploadOptions,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  if (Platform.OS === "web") {
    opts.onProgress?.(0);
    // The picker/recorder gives a blob: URL; read it, then append as a Blob.
    const part = formDataPart(
      file,
      async () => new Uint8Array(await (await fetch(file.uri)).arrayBuffer()),
      opts.fallbackType,
    );
    const body = new FormData();
    body.append(
      "file",
      new Blob([(await part.bytes()) as Uint8Array<ArrayBuffer>], {
        type: part.type,
      }),
      part.name,
    );
    for (const [k, v] of Object.entries(opts.fields ?? {})) body.append(k, v);
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      body,
      signal: opts.signal,
    });
    opts.onProgress?.(1);
    return parseUploadResponse<T>(res.status, await res.text());
  }

  const task = new File(file.uri).createUploadTask(url, {
    httpMethod: "POST",
    uploadType: UploadType.MULTIPART,
    fieldName: "file",
    mimeType: uploadType(file, opts.fallbackType),
    parameters: opts.fields,
    headers: { ...cookieHeader(), Accept: "application/json" },
    // In the foreground: the JS side waits for the answer anyway, and a
    // background iOS session outlives the promise it would resolve.
    sessionType: "foreground",
    signal: opts.signal,
    onProgress: ({ bytesSent, totalBytes }) => {
      if (totalBytes > 0)
        opts.onProgress?.(Math.min(1, bytesSent / totalBytes));
    },
  });
  const result = await task.uploadAsync();
  opts.onProgress?.(1);
  return parseUploadResponse<T>(result.status, result.body);
}

/** A photo (or any allow-listed file) into the tenant's media library. */
export function uploadMedia(
  file: LocalFile,
  opts: UploadOptions = {},
): Promise<MediaAsset> {
  return postFile<MediaAsset>("/api/media/upload", file, {
    fallbackType: "image/jpeg",
    ...opts,
  });
}

/** A recording to text. Not stored on the server. */
export function transcribeAudio(
  file: LocalFile,
  opts: UploadOptions & { language?: string } = {},
): Promise<{ text: string; seconds: number | null }> {
  const { language, ...rest } = opts;
  return postFile("/api/media/transcribe", file, {
    fallbackType: "audio/mp4",
    ...rest,
    fields: { ...rest.fields, ...(language ? { language } : {}) },
  });
}
