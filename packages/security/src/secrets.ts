/**
 * Sealing third-party secrets at rest (OAuth refresh tokens, API keys a tenant
 * gives us): AES-256-GCM, so a tampered ciphertext fails to open rather than
 * decrypting to garbage.
 *
 * Wire format, one string:  v1:<iv>:<authTag>:<ciphertext>   (base64 parts)
 * Byte-compatible with the format the production apps already store, so their
 * rows can be moved without re-encrypting.
 *
 * Keys come from env: SECRETS_ENCRYPTION_KEY seals; it and every key in
 * SECRETS_ENCRYPTION_OLD_KEYS can open. To rotate: put a new key in
 * SECRETS_ENCRYPTION_KEY, move the old one to _OLD_KEYS, then re-seal rows
 * whose `openSecretDetailed(...).needsReseal` is true; drop the old key after.
 *
 * `aad` (optional) binds a ciphertext to where it lives, e.g.
 * `account:<id>:refreshToken`: a sealed value copied into another row then
 * refuses to open. It must be the same on seal and open.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@repo/env";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface SealingKeys {
  /** Seals, and is tried first when opening. */
  current: Buffer;
  /** Retired keys: open only. */
  old: Buffer[];
}

function decodeKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${name} must be base64 of ${KEY_BYTES} bytes (got ${key.length}). Generate: openssl rand -base64 32`,
    );
  }
  return key;
}

/** The keys from env. Throws a readable error when sealing is not configured. */
export function keysFromEnv(): SealingKeys {
  const e = env();
  if (!e.SECRETS_ENCRYPTION_KEY) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.",
    );
  }
  return {
    current: decodeKey(e.SECRETS_ENCRYPTION_KEY, "SECRETS_ENCRYPTION_KEY"),
    old: (e.SECRETS_ENCRYPTION_OLD_KEYS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((k) => decodeKey(k, "SECRETS_ENCRYPTION_OLD_KEYS")),
  };
}

export function sealSecret(
  plaintext: string,
  opts: { aad?: string; keys?: SealingKeys } = {},
): string {
  const keys = opts.keys ?? keysFromEnv();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keys.current, iv);
  if (opts.aad) cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === "string" ? p : p.toString("base64")))
    .join(":");
}

/**
 * Open a sealed value, trying the current key then each old one.
 * `needsReseal` is true when an old key opened it.
 */
export function openSecretDetailed(
  sealed: string,
  opts: { aad?: string; keys?: SealingKeys } = {},
): { plaintext: string; needsReseal: boolean } {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("openSecret: not a sealed value (expected v1:iv:tag:data)");
  }
  const [, iv, tag, data] = parts.map((p) => Buffer.from(p, "base64")) as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ];
  // Exact lengths, and the tag length pinned on the decipher: without it Node
  // accepts a TRUNCATED tag (down to 4 bytes), which makes forging a
  // ciphertext a matter of ~2^32 guesses instead of 2^128.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error(
      "openSecret: malformed sealed value (bad iv or tag length)",
    );
  }
  const keys = opts.keys ?? keysFromEnv();
  const candidates = [keys.current, ...keys.old];
  for (const [i, key] of candidates.entries()) {
    try {
      const decipher = createDecipheriv(ALGO, key, iv, {
        authTagLength: TAG_BYTES,
      });
      if (opts.aad) decipher.setAAD(Buffer.from(opts.aad, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(data),
        decipher.final(),
      ]).toString("utf8");
      return { plaintext, needsReseal: i > 0 };
    } catch {
      // Wrong key (or tampered): GCM's tag check failed. Try the next key.
    }
  }
  throw new Error(
    "openSecret: no configured key opens this value (wrong key, wrong aad, or tampered)",
  );
}

export function openSecret(
  sealed: string,
  opts: { aad?: string; keys?: SealingKeys } = {},
): string {
  return openSecretDetailed(sealed, opts).plaintext;
}

/** For startup checks and feature flags: is sealing configured at all? */
export function sealingConfigured(): boolean {
  try {
    keysFromEnv();
    return true;
  } catch {
    return false;
  }
}
