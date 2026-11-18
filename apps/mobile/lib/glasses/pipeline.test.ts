import { describe, expect, it, jest } from "@jest/globals";

import {
  captureAndDescribe,
  photoFileName,
  PipelineError,
  type PipelineDeps,
} from "./pipeline";

const photo = { uri: "file:///g.jpg", mimeType: "image/jpeg" };
const at = () => new Date("2026-11-18T10:20:30.456Z");

function deps(over: Partial<PipelineDeps> = {}) {
  const steps: string[] = [];
  const d: PipelineDeps = {
    capture: async () => photo,
    upload: async (_file, onProgress) => {
      onProgress(1);
      return { id: "m1" };
    },
    onStep: (s, p) => steps.push(p === undefined ? s : `${s}:${p}`),
    ...over,
  };
  return { d, steps };
}

describe("captureAndDescribe", () => {
  it("captures, uploads with a dated name, describes and speaks, in order", async () => {
    const upload = jest.fn(async () => ({ id: "m1" }));
    const describe = jest.fn(async () => ({ text: "A red door." }));
    const speak = jest.fn(async () => {});
    const { d, steps } = deps({ upload, describe, speak });
    const r = await captureAndDescribe(d, "glasses", at);
    expect(r).toEqual({ photo, mediaId: "m1", description: "A red door." });
    expect(upload).toHaveBeenCalledWith(
      {
        uri: photo.uri,
        type: "image/jpeg",
        name: "glasses-2026-11-18T10-20-30.jpg",
      },
      expect.any(Function),
    );
    expect(describe).toHaveBeenCalledWith("m1");
    expect(speak).toHaveBeenCalledWith("A red door.");
    expect(steps).toEqual(["capture", "upload", "describe", "speak"]);
  });

  it("without describe, stops after the upload (AI is optional)", async () => {
    const { d, steps } = deps({ speak: jest.fn(async () => {}) });
    const r = await captureAndDescribe(d);
    expect(r.description).toBeNull();
    expect(steps).toEqual(["capture", "upload", "upload:1"]);
  });

  it("names the failing step and keeps what already succeeded", async () => {
    const { d } = deps({
      describe: async () => {
        throw new Error("Today's AI budget is used up.");
      },
    });
    const err = await captureAndDescribe(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).step).toBe("describe");
    expect((err as PipelineError).message).toBe(
      "Describing failed: Today's AI budget is used up.",
    );
    expect((err as PipelineError).partial).toMatchObject({
      photo,
      mediaId: "m1",
    });
  });

  it("a failed capture uploads nothing", async () => {
    const upload = jest.fn(async () => ({ id: "x" }));
    const { d } = deps({
      capture: async () => {
        throw new Error("not connected");
      },
      upload,
    });
    await expect(captureAndDescribe(d)).rejects.toMatchObject({
      step: "capture",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not speak an empty description", async () => {
    const speak = jest.fn(async () => {});
    const { d } = deps({ describe: async () => ({ text: "  " }), speak });
    await captureAndDescribe(d);
    expect(speak).not.toHaveBeenCalled();
  });
});

describe("photoFileName", () => {
  it("is filesystem-safe", () => {
    expect(photoFileName("phone", at())).toBe("phone-2026-11-18T10-20-30.jpg");
  });
});
