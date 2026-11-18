/**
 * The phone-side half of keeping photos small and short-lived:
 *
 *   shrink()  at most MAX_EDGE px on the long edge, JPEG at quality 0.8. A
 *             12 MP phone photo becomes ~300-600 KB: faster upload, and well
 *             under the server's describe limit (ai.describeImage). Vision
 *             models downsize beyond ~1568 px anyway.
 *   discard() delete local copies once uploaded: a photo of someone's
 *             surroundings should not linger in the app's cache.
 *
 * The glasses module already saves at this size; shrink() is then a no-op.
 */
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import type { GlassesPhoto } from "../../modules/glasses";

export const MAX_EDGE = 1568;
export const JPEG_QUALITY = 0.8;

/** The resize to ask for, or null when the photo is small enough already. */
export function shrinkTarget(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}

export async function shrink(photo: GlassesPhoto): Promise<GlassesPhoto> {
  const probe = await ImageManipulator.manipulate(photo.uri).renderAsync();
  const target = shrinkTarget(probe.width, probe.height);
  if (!target && photo.mimeType === "image/jpeg") return photo;
  const ctx = ImageManipulator.manipulate(photo.uri);
  if (target) ctx.resize(target);
  const out = await (
    await ctx.renderAsync()
  ).saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
  return {
    uri: out.uri,
    mimeType: "image/jpeg",
    width: out.width,
    height: out.height,
  };
}

/** Best effort: a file that is already gone is fine. */
export function discard(uris: string[]): void {
  for (const uri of new Set(uris)) {
    if (!uri.startsWith("file:")) continue;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // Cache files are cleared by the OS eventually; never fail the flow.
    }
  }
}
