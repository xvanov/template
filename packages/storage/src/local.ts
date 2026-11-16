import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { env } from "@repo/env";

import type { PutResult, StorageDriver } from "./types";

export function localDriver(): StorageDriver {
  // Relative to the PROCESS cwd, which differs per entrypoint (apps/web when
  // run by npm, /app in the container). Log it once so "where did my upload
  // go?" is never a mystery; set an absolute STORAGE_LOCAL_DIR to pin it.
  const root = resolve(env().STORAGE_LOCAL_DIR);
  console.log(`[storage] local driver root: ${root}`);

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the
   * storage root. Keys reach this function from request bodies; without this
   * check `../../.env` is a readable object.
   */
  const pathFor = (key: string): string => {
    const full = resolve(join(root, normalize(key)));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`Refusing key outside storage root: ${key}`);
    }
    return full;
  };

  return {
    name: "local",

    async put(key, body, _contentType): Promise<PutResult> {
      const path = pathFor(key);
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      // Durable AND atomic: write a temp file in the same directory, fsync it,
      // rename it over the target, then fsync the directory so the rename
      // itself survives a crash. Readers see the old object or the new one —
      // never a torn write — and we only acknowledge once the bytes are on disk.
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(tmp, "wx");
        try {
          await handle.writeFile(body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      await syncDir(dir);
      return { key, sizeBytes: body.byteLength };
    },

    async get(key) {
      return new Uint8Array(await readFile(pathFor(key)));
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },

    async exists(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },

    async url(key) {
      // Served by the web app's own authenticated route, which re-checks that
      // the caller's tenant owns the asset before streaming bytes. The key
      // travels as a query parameter because it contains slashes.
      return `/api/media/blob?key=${encodeURIComponent(key)}`;
    },
  };
}

/**
 * fsync a directory so a rename into it is durable. Best-effort: Windows cannot
 * open a directory for syncing, and some filesystems refuse it; the data file
 * itself is already synced by then.
 */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not fatal — see above.
  }
}
