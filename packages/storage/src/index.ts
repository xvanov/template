/**
 * File / media storage — one interface, two drivers.
 *
 *   STORAGE_DRIVER=local  → the local filesystem (default; zero setup)
 *   STORAGE_DRIVER=s3     → any S3-compatible bucket (AWS, R2, MinIO, B2)
 *
 * Application code only ever sees object *keys*. Switching from local disk to
 * a bucket in production is an .env change, not a code change.
 *
 * Keys are namespaced by tenant: `org/<organizationId>/<yyyy-mm>/<nanoid><ext>`
 * so a listing, a lifecycle rule or a tenant deletion is a prefix operation.
 */
import { env } from "@repo/env";
import { nanoid } from "nanoid";

import { localDriver } from "./local";
import { s3Driver } from "./s3";
import type { StorageDriver } from "./types";

export type { StorageDriver, PutResult } from "./types";

let driver: StorageDriver | undefined;

export function storage(): StorageDriver {
  driver ??= env().STORAGE_DRIVER === "s3" ? s3Driver() : localDriver();
  return driver;
}

/** Build a tenant-namespaced key for a new upload. */
export function buildKey(organizationId: string, filename: string): string {
  const month = new Date().toISOString().slice(0, 7);
  const ext = extensionOf(filename);
  return `org/${organizationId}/${month}/${nanoid(16)}${ext}`;
}

/**
 * Content types we accept by default. Deliberately a strict allow-list, not a
 * deny-list: an upload endpoint that accepts `text/html` or `image/svg+xml`
 * and later serves it from your own origin is a stored-XSS vector.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
  "text/plain",
  "text/csv",
]);

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function assertUploadAllowed(
  contentType: string,
  sizeBytes: number,
): void {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  if (sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large: ${sizeBytes} bytes (max ${MAX_UPLOAD_BYTES})`,
    );
  }
}

/**
 * Audio accepted for transcription (the AI module's upload route). Not stored:
 * these never reach the media allow-list above. The aliases phones send for
 * the same format are normalised (normalizeAudioType) before the check.
 */
export const AUDIO_CONTENT_TYPES = new Set([
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);

/** Under the 25 MB OpenAI's /audio/transcriptions accepts; ~25 min of AAC. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const AUDIO_ALIASES: Record<string, string> = {
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/mp4a-latm": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-aac": "audio/aac",
};

/** `audio/x-m4a; codecs=...` → `audio/mp4`. Lowercased, parameters dropped. */
export function normalizeAudioType(contentType: string): string {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return AUDIO_ALIASES[base] ?? base;
}

export function assertAudioAllowed(
  contentType: string,
  sizeBytes: number,
): void {
  if (!AUDIO_CONTENT_TYPES.has(normalizeAudioType(contentType))) {
    throw new Error(`Unsupported audio type: ${contentType}`);
  }
  if (sizeBytes <= 0 || sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error(
      `Recording too large: ${sizeBytes} bytes (max ${MAX_AUDIO_BYTES})`,
    );
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  const ext = filename.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}
