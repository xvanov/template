/**
 * The JS contract of the glasses module. Part 4c implements it natively
 * (Meta Wearables Device Access Toolkit); app code depends only on this.
 */

/** Why glasses features cannot be used, or "available". */
export type GlassesAvailability =
  | { status: "available" }
  | {
      status: "unavailable";
      /**
       * no_native_module: this build has no glasses SDK (Expo Go, web, or a
       *   dev client built before the module was added).
       * unsupported_platform: the SDK does not run here.
       */
      reason: "no_native_module" | "unsupported_platform";
    };

export interface GlassesDevice {
  id: string;
  name: string;
}

/** A photo captured on the glasses, saved to a local file the app can upload. */
export interface GlassesPhoto {
  uri: string;
  mimeType: string;
}

/** What the native module must export (names are the native function names). */
export interface GlassesNativeModule {
  isSupported(): boolean;
  connect(): Promise<GlassesDevice>;
  disconnect(): Promise<void>;
  capturePhoto(): Promise<GlassesPhoto>;
}
