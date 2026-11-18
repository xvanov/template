/**
 * The JS contract of the glasses module (Meta Wearables Device Access
 * Toolkit). App code depends only on this; ../android and ../ios implement
 * `GlassesNativeModule` with the same function and event names.
 */

/** Why glasses features cannot be used, or "available". */
export type GlassesAvailability =
  | { status: "available" }
  | {
      status: "unavailable";
      /**
       * no_native_module: this build has no glasses SDK (Expo Go, web, or a
       *   build made without GLASSES_ENABLED=true).
       * unsupported_platform: not iOS or Android.
       */
      reason: "no_native_module" | "unsupported_platform";
    };

/**
 * Is this app linked to the glasses in the Meta AI app?
 *   uninitialized  the SDK has not been started yet (call initialize()).
 *   unavailable    the Meta AI app is missing, or registration is not possible.
 *   unregistered   possible; call register().
 */
export type GlassesRegistration =
  | "uninitialized"
  | "unavailable"
  | "unregistered"
  | "registering"
  | "registered"
  | "unregistering"
  | "unknown";

/** Everything the native side knows, sent whole on every change. */
export interface GlassesStatus {
  platform: "ios" | "android";
  registration: GlassesRegistration;
  /** Names of the glasses the SDK can see. */
  devices: string[];
  deviceCount: number;
  /** DeviceSession state, lowercase SDK names: idle, starting, started, paused, stopping, stopped. */
  session: string;
  /** Camera stream state: stopped, starting, started, streaming, paused, stopping, closed. */
  stream: string;
  /** MockDeviceKit (simulated glasses) is active. */
  mockDevice: boolean;
  /** MockDeviceKit is compiled into this build (GLASSES_MOCK_DEVICE). */
  mockDeviceAvailable: boolean;
}

export interface GlassesDevice {
  id: string;
  name: string;
}

/** A photo, saved to a local file the app can upload (lib/upload.ts). */
export interface GlassesPhoto {
  uri: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface GlassesEvents {
  onStatus: (status: GlassesStatus) => void;
  onError: (event: { message: string }) => void;
}

export interface Subscription {
  remove(): void;
}

/** What the native module exports (names are the native function names). */
export interface GlassesNativeModule {
  isSupported(): boolean;
  getStatus(): GlassesStatus;
  initialize(): Promise<GlassesStatus>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  requestCameraPermission(): Promise<"granted" | "denied">;
  connect(): Promise<GlassesDevice>;
  disconnect(): Promise<void>;
  capturePhoto(): Promise<GlassesPhoto>;
  enableMockDevice(usePhoneCamera: boolean): Promise<boolean>;
  disableMockDevice(): Promise<void>;
  addListener<E extends keyof GlassesEvents>(
    event: E,
    listener: GlassesEvents[E],
  ): Subscription;
}
