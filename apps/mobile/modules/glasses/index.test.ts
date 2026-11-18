import { describe, expect, it } from "@jest/globals";

import {
  availability,
  capturePhoto,
  connect,
  GlassesUnavailableError,
} from "./index";

describe("glasses without the native module (Expo Go, or no SDK yet)", () => {
  it("reports unavailable instead of crashing", () => {
    expect(availability()).toEqual({
      status: "unavailable",
      reason: "no_native_module",
    });
  });

  it("actions reject with a typed error the UI can show", async () => {
    await expect(connect()).rejects.toBeInstanceOf(GlassesUnavailableError);
    await expect(capturePhoto()).rejects.toThrow("Glasses are unavailable");
  });
});
