/**
 * Smart glasses: the typed JS API, ready before the native code is.
 *
 * Every function works on every platform. Without the native module (Expo Go,
 * web, a build without the SDK) `availability()` says why, and the actions
 * throw GlassesUnavailableError, so screens can show "not available on this
 * device" instead of crashing. See ./README.md for adding the native side.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type {
  GlassesAvailability,
  GlassesDevice,
  GlassesNativeModule,
  GlassesPhoto,
} from "./src/types";

export type {
  GlassesAvailability,
  GlassesDevice,
  GlassesPhoto,
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

export async function connect(): Promise<GlassesDevice> {
  return requireModule().connect();
}

export async function disconnect(): Promise<void> {
  return requireModule().disconnect();
}

/** Take a photo on the glasses; upload it like any other (lib/upload.ts). */
export async function capturePhoto(): Promise<GlassesPhoto> {
  return requireModule().capturePhoto();
}
