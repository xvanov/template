import { describe, expect, it, jest } from "@jest/globals";

import * as Glasses from "./index";

describe("glasses without the native module (Expo Go, or GLASSES_ENABLED off)", () => {
  it("reports unavailable instead of crashing", () => {
    expect(Glasses.availability()).toEqual({
      status: "unavailable",
      reason: "no_native_module",
    });
    expect(Glasses.getStatus()).toBeNull();
  });

  it("every action rejects with a typed error the UI can show", async () => {
    const actions = [
      Glasses.initialize,
      Glasses.register,
      Glasses.unregister,
      Glasses.requestCameraPermission,
      Glasses.connect,
      Glasses.disconnect,
      Glasses.capturePhoto,
      () => Glasses.enableMockDevice(),
      Glasses.disableMockDevice,
    ];
    for (const action of actions) {
      await expect(action()).rejects.toBeInstanceOf(
        Glasses.GlassesUnavailableError,
      );
    }
    await expect(Glasses.capturePhoto()).rejects.toThrow(
      "Glasses are unavailable (no_native_module).",
    );
  });

  it("listeners are harmless no-ops", () => {
    const sub = Glasses.addStatusListener(() => {});
    expect(() => sub.remove()).not.toThrow();
    expect(() => Glasses.addErrorListener(() => {}).remove()).not.toThrow();
  });
});

describe("glasses with a native module", () => {
  it("passes calls through, and the simulator uses the phone camera by default", async () => {
    const native = {
      isSupported: () => true,
      getStatus: () => ({ registration: "registered" }),
      enableMockDevice: jest.fn(async (_phone: boolean) => true),
      capturePhoto: async () => ({
        uri: "file:///x.jpg",
        mimeType: "image/jpeg",
      }),
      addListener: jest.fn(() => ({ remove() {} })),
    };
    jest.resetModules();
    jest.doMock("expo", () => ({
      requireOptionalNativeModule: (name: string) =>
        name === "Glasses" ? native : null,
    }));
    const G = jest.requireActual<typeof import("./index")>("./index");
    expect(G.availability()).toEqual({ status: "available" });
    expect(G.getStatus()).toEqual({ registration: "registered" });
    await expect(G.enableMockDevice()).resolves.toBe(true);
    expect(native.enableMockDevice).toHaveBeenCalledWith(true);
    await expect(G.capturePhoto()).resolves.toMatchObject({
      uri: "file:///x.jpg",
    });
    G.addStatusListener(() => {});
    expect(native.addListener).toHaveBeenCalledWith(
      "onStatus",
      expect.any(Function),
    );
    jest.dontMock("expo");
  });
});
