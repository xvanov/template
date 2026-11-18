/**
 * Meta smart glasses: the typed JS API over the native module (./android,
 * ./ios), which wraps Meta's Wearables Device Access Toolkit.
 *
 * Every function works on every platform. Without the native module (Expo
 * Go, web, or a build without GLASSES_ENABLED=true) `availability()` says
 * why, and the actions throw GlassesUnavailableError, so screens can show
 * "not available in this build" instead of crashing. See ./README.md.
 *
 * Typical flow:
 *   await initialize();                 // Bluetooth permission + SDK start
 *   if (getStatus().registration !== "registered") await register(); // Meta AI app
 *   await connect();                    // session + camera stream
 *   const photo = await capturePhoto(); // a local JPEG
 *   await disconnect();
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type {
  GlassesAvailability,
  GlassesDevice,
  GlassesEvents,
  GlassesNativeModule,
  GlassesPhoto,
  GlassesStatus,
  Subscription,
} from "./src/types";

export type {
  GlassesAvailability,
  GlassesDevice,
  GlassesPhoto,
  GlassesRegistration,
  GlassesStatus,
  Subscription,
} from "./src/types";

/** The native module's registered name (`Name("Glasses")` in its definition). */
export const NATIVE_MODULE_NAME = "Glasses";

export class GlassesUnavailableError extends Error {
  constructor(readonly availability: GlassesAvailability) {
    super(
      availability.status === "unavailable"
        ? `Glasses are unavailable (${availability.reason}).`
        : "Glasses are unavailable.",
    );
    this.name = "GlassesUnavailableError";
  }
}

function nativeModule(): GlassesNativeModule | null {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  return requireOptionalNativeModule<GlassesNativeModule>(NATIVE_MODULE_NAME);
}

export function availability(): GlassesAvailability {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { status: "unavailable", reason: "unsupported_platform" };
  }
  const m = nativeModule();
  if (!m) return { status: "unavailable", reason: "no_native_module" };
  return m.isSupported()
    ? { status: "available" }
    : { status: "unavailable", reason: "unsupported_platform" };
}

function requireModule(): GlassesNativeModule {
  const a = availability();
  const m = nativeModule();
  if (a.status !== "available" || !m) throw new GlassesUnavailableError(a);
  return m;
}

/** Status without touching the SDK; null when the module is unavailable. */
export function getStatus(): GlassesStatus | null {
  return availability().status === "available"
    ? requireModule().getStatus()
    : null;
}

/** Asks for Bluetooth permission and starts the SDK. Safe to call repeatedly. */
export async function initialize(): Promise<GlassesStatus> {
  return requireModule().initialize();
}

/** Opens the Meta AI app so the wearer can link this app to their glasses. */
export async function register(): Promise<void> {
  return requireModule().register();
}

export async function unregister(): Promise<void> {
  return requireModule().unregister();
}

/** Camera access on the glasses is granted in the Meta AI app (it may open). */
export async function requestCameraPermission(): Promise<"granted" | "denied"> {
  return requireModule().requestCameraPermission();
}

/**
 * Starts a session with the glasses and their camera stream (asking for
 * camera permission if needed). The capture LED on the glasses is on while
 * the stream runs: call disconnect() as soon as you are done.
 */
export async function connect(): Promise<GlassesDevice> {
  return requireModule().connect();
}

export async function disconnect(): Promise<void> {
  return requireModule().disconnect();
}

/** A still from the glasses camera, as a local JPEG. Needs connect() first. */
export async function capturePhoto(): Promise<GlassesPhoto> {
  return requireModule().capturePhoto();
}

/**
 * Simulated glasses (Meta's MockDeviceKit): registered, permitted, worn, and
 * with `usePhoneCamera` the phone's back camera as their camera. Resolves
 * false when this build has no MockDeviceKit (GLASSES_MOCK_DEVICE=false).
 */
export async function enableMockDevice(
  options: { usePhoneCamera?: boolean } = {},
): Promise<boolean> {
  return requireModule().enableMockDevice(options.usePhoneCamera ?? true);
}

export async function disableMockDevice(): Promise<void> {
  return requireModule().disableMockDevice();
}

const NOOP: Subscription = { remove() {} };

/** Every status change, whole. A no-op subscription when unavailable. */
export function addStatusListener(
  listener: GlassesEvents["onStatus"],
): Subscription {
  const m = availability().status === "available" ? nativeModule() : null;
  return m ? m.addListener("onStatus", listener) : NOOP;
}

/** Asynchronous SDK errors (session dropped, stream error, …). */
export function addErrorListener(
  listener: GlassesEvents["onError"],
): Subscription {
  const m = availability().status === "available" ? nativeModule() : null;
  return m ? m.addListener("onError", listener) : NOOP;
}
