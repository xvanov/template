import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
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
