/**
 * The upload body, checked against the encoder that actually runs on the
 * phone: expo/fetch's FormData conversion (installed as the global fetch
 * since SDK 52). The old React Native part shape fails there; ours must not.
 */
import { describe, expect, it } from "@jest/globals";
import { convertFormDataAsync } from "expo/src/winter/fetch/convertFormData";

import {
  formDataPart,
  parseUploadResponse,
  UploadError,
  uploadName,
  uploadType,
} from "./upload-body";

/** The minimal FormData expo's encoder reads: entries(). */
function formOf(entries: [string, unknown][]): FormData {
  return { entries: () => entries } as unknown as FormData;
}

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // a JPEG's first bytes
/** One char per byte, so binary bytes survive the comparison. */
const latin1 = (b: Uint8Array) =>
  Array.from(b, (c) => String.fromCharCode(c)).join("");

describe("formDataPart against expo/fetch's encoder", () => {
  it("the classic { uri, name, type } part is what breaks (the regression)", async () => {
    const legacy = { uri: "file:///x.jpg", name: "x.jpg", type: "image/jpeg" };
    await expect(
      convertFormDataAsync(formOf([["file", legacy]]), "B"),
    ).rejects.toThrow("Unsupported FormDataPart implementation");
  });

  it("our part encodes, with the file's bytes, name and normalised type", async () => {
    const part = formDataPart(
      { uri: "file:///cache/IMG_1.JPG", name: null, type: "image/jpg" },
      async () => bytes,
    );
    const { body } = await convertFormDataAsync(formOf([["file", part]]), "B");
    const text = latin1(body);
    expect(text).toContain(
      'content-disposition: form-data; name="file"; filename="IMG_1.JPG"',
    );
    expect(text).toContain("content-type: image/jpeg");
    expect(text).toContain(latin1(bytes));
    expect(text.endsWith("--B--\r\n")).toBe(true);
  });
});

describe("uploadType", () => {
  it("fixes the aliases phones send that a strict allow-list refuses", () => {
    expect(uploadType({ uri: "x", type: "image/jpg" })).toBe("image/jpeg");
    expect(uploadType({ uri: "x", type: "audio/x-m4a" })).toBe("audio/mp4");
    expect(uploadType({ uri: "x", type: "IMAGE/PNG; q=1" })).toBe("image/png");
  });

  it("falls back to the extension, then to the caller's default", () => {
    expect(uploadType({ uri: "file:///a/b.heic" })).toBe("image/heic");
    expect(uploadType({ uri: "file:///a/rec", name: "note.m4a" })).toBe(
      "audio/mp4",
    );
    expect(
      uploadType({ uri: "file:///a/x", type: "application/octet-stream" }),
    ).toBe("image/jpeg");
    expect(uploadType({ uri: "blob:abc" }, "audio/webm")).toBe("audio/webm");
  });
});

describe("uploadName", () => {
  it("keeps a name with an extension, else adds the type's", () => {
    expect(uploadName({ uri: "x", name: "a.png" }, "image/png")).toBe("a.png");
    expect(uploadName({ uri: "file:///c/abc" }, "image/jpeg")).toBe("abc.jpg");
    expect(uploadName({ uri: "file:///c/" }, "audio/mp4")).toBe("upload.m4a");
  });
});

describe("parseUploadResponse", () => {
  it("returns the JSON on 2xx", () => {
    expect(parseUploadResponse(201, '{"id":"a"}')).toEqual({ id: "a" });
  });

  it("throws the server's own message, else the status", () => {
    expect(() =>
      parseUploadResponse(415, '{"error":"Unsupported content type"}'),
    ).toThrow("Unsupported content type");
    expect(() => parseUploadResponse(502, "<html>")).toThrow(
      "Upload failed (502).",
    );
    try {
      parseUploadResponse(413, "{}");
    } catch (err) {
      expect(err).toBeInstanceOf(UploadError);
      expect((err as UploadError).status).toBe(413);
    }
  });
});
