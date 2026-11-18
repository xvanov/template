/**
 * The parts of an upload that need no device: naming, content types, the
 * multipart part, reading the server's answer. Pure, so they are unit tests
 * (upload-body.test.ts). The I/O is in ./upload.ts.
 *
 * THE BUG THIS AVOIDS (found in an app built from this template): since
 * SDK 52 Expo installs its own `fetch` (expo/fetch) globally, and its
 * FormData encoder accepts only a string, a Blob, or an object with a
 * `bytes()` method. React Native's classic file part,
 *   body.append("file", { uri, name, type })
 * which every RN upload example uses, throws "Unsupported FormDataPart
 * implementation" there, so the upload never leaves the phone. The part
 * below carries `bytes()` instead of `uri`. (The native path in upload.ts
 * avoids JS FormData entirely; this is the fetch path's body.)
 */

export interface LocalFile {
  /** file://… on a phone; blob:/data: on web. */
  uri: string;
  /** Picker/recorder name, if it gave one. */
  name?: string | null;
  /** Picker/recorder MIME type, if it gave one. */
  type?: string | null;
}

/** What the server's allow-lists expect, keyed by the aliases phones send. */
const TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/heif": "image/heic",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
};

const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
  caf: "audio/x-caf",
};

const EXTENSION_FOR: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

function extensionOf(path: string): string | null {
  const clean = path.split(/[?#]/)[0] ?? "";
  const m = /\.([a-z0-9]{1,5})$/i.exec(clean);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The content type to send: the given one with aliases fixed (`image/jpg`
 * is refused by a strict allow-list), else guessed from the file name or
 * URI, else `fallback`.
 */
export function uploadType(file: LocalFile, fallback = "image/jpeg"): string {
  const given = file.type?.split(";")[0]?.trim().toLowerCase();
  if (given && given.includes("/") && given !== "application/octet-stream") {
    return TYPE_ALIASES[given] ?? given;
  }
  const ext = extensionOf(file.name ?? "") ?? extensionOf(file.uri);
  return (ext && BY_EXTENSION[ext]) || fallback;
}

/** A file name with an extension matching the type (servers key on it). */
export function uploadName(file: LocalFile, type: string): string {
  const base =
    file.name?.trim() ||
    decodeURIComponent(file.uri.split(/[?#]/)[0]!.split("/").pop() ?? "") ||
    "upload";
  if (extensionOf(base)) return base.slice(0, 200);
  const ext = EXTENSION_FOR[type];
  return `${base.slice(0, 190)}${ext ? `.${ext}` : ""}`;
}

/**
 * A multipart part expo/fetch can encode: name, type and `bytes()`. NOT
 * `{ uri, name, type }` (see the header).
 */
export function formDataPart(
  file: LocalFile,
  readBytes: () => Promise<Uint8Array>,
  fallbackType?: string,
): { name: string; type: string; bytes: () => Promise<Uint8Array> } {
  const type = uploadType(file, fallbackType);
  return { name: uploadName(file, type), type, bytes: readBytes };
}

/**
 * The server's answer as JSON, or an Error carrying the server's own
 * message (the media routes answer `{ error }`), else the status.
 */
export function parseUploadResponse<T>(status: number, body: string): T {
  let json: unknown = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // not JSON: fall through to the status
  }
  if (status >= 200 && status < 300 && json !== null) return json as T;
  const message =
    json && typeof json === "object" && "error" in json
      ? String((json as { error: unknown }).error)
      : null;
  throw new UploadError(
    message ??
      (status === 0
        ? "Could not reach the server."
        : `Upload failed (${status}).`),
    status,
  );
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}
