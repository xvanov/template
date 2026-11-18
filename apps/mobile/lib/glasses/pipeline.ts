/**
 * The glasses capture flow, as plain steps with injected I/O so it is a unit
 * test (pipeline.test.ts), not a device test:
 *
 *   capture (glasses, simulated glasses, or the phone camera)
 *     → shrink (≤ 1568 px, JPEG 0.8: ./photo-files.ts)
 *     → upload into the media library, then delete the local copies (the same path as the Photos screen)
 *     → optionally describe it with AI (ai.describeImage: discretionary,
 *       capped, priced into llm_call)
 *     → optionally speak the description (expo-speech; it plays through the
 *       glasses' open-ear speakers when they are the phone's audio output)
 *
 * Each step reports progress, and a failure says WHICH step failed, with the
 * steps that succeeded kept (a photo that uploaded stays uploaded).
 */
import type { GlassesPhoto } from "../../modules/glasses";
import type { LocalFile } from "../upload-body";

export type PipelineStep = "capture" | "upload" | "describe" | "speak";

export interface PipelineDeps {
  capture(): Promise<GlassesPhoto>;
  /** Make the photo upload-sized. Omit to upload as captured. */
  shrink?(photo: GlassesPhoto): Promise<GlassesPhoto>;
  upload(
    file: LocalFile,
    onProgress: (fraction: number) => void,
  ): Promise<{ id: string; url: string }>;
  /** Delete local files once uploaded (best effort, never throws). */
  discard?(uris: string[]): void;
  /** Omit to skip the AI step. */
  describe?(mediaId: string): Promise<{ text: string }>;
  /** Omit to skip speaking. */
  speak?(text: string): Promise<void>;
  onStep?(step: PipelineStep, progress?: number): void;
}

export interface PipelineResult {
  photo: GlassesPhoto;
  mediaId: string;
  /** The uploaded photo (its local file is gone once uploaded). */
  mediaUrl: string;
  description: string | null;
}

export class PipelineError extends Error {
  constructor(
    readonly step: PipelineStep,
    readonly cause: unknown,
    readonly partial: Partial<PipelineResult>,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${STEP_LABEL[step]} failed: ${message}`);
    this.name = "PipelineError";
  }
}

const STEP_LABEL: Record<PipelineStep, string> = {
  capture: "Taking the photo",
  upload: "Uploading",
  describe: "Describing",
  speak: "Speaking",
};

/** A name for the media library: when and where it came from. */
export function photoFileName(source: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${source}-${stamp}.jpg`;
}

export async function captureAndDescribe(
  deps: PipelineDeps,
  source = "glasses",
  now: () => Date = () => new Date(),
): Promise<PipelineResult> {
  const step = async <T>(
    name: PipelineStep,
    partial: Partial<PipelineResult>,
    run: () => Promise<T>,
  ): Promise<T> => {
    deps.onStep?.(name);
    try {
      return await run();
    } catch (err) {
      throw new PipelineError(name, err, partial);
    }
  };

  const captured = await step("capture", {}, deps.capture);
  const shrink = deps.shrink;
  const photo = shrink
    ? await step("upload", { photo: captured }, () => shrink(captured))
    : captured;
  const asset = await step("upload", { photo }, () =>
    deps.upload(
      {
        uri: photo.uri,
        type: photo.mimeType,
        name: photoFileName(source, now()),
      },
      (p) => deps.onStep?.("upload", p),
    ),
  );
  deps.discard?.([captured.uri, photo.uri]);
  const done: PipelineResult = {
    photo,
    mediaId: asset.id,
    mediaUrl: asset.url,
    description: null,
  };
  const describe = deps.describe;
  if (!describe) return done;

  const { text } = await step("describe", done, () => describe(asset.id));
  done.description = text;
  const speak = deps.speak;
  if (speak && text.trim()) await step("speak", done, () => speak(text));
  return done;
}
