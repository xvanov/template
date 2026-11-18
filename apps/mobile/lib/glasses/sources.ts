/**
 * Where a "glasses" photo comes from. Three sources, one interface, so the
 * capture screen and the pipeline do not care which is in use:
 *
 *   glasses    real glasses through the Device Access Toolkit (a build with
 *              GLASSES_ENABLED=true, glasses linked in the Meta AI app).
 *   simulated  Meta's MockDeviceKit inside the same native module: the SDK's
 *              real session/stream/capture path, the phone's back camera as
 *              the glasses' camera. Needs the same build, no hardware.
 *   phone      the phone camera through expo-image-picker. Works everywhere,
 *              Expo Go included: the hackathon fallback that still drives
 *              the full upload → describe → speak pipeline.
 */
import * as ImagePicker from "expo-image-picker";

import * as Glasses from "../../modules/glasses";
import type { GlassesPhoto } from "../../modules/glasses";

export type SourceKind = "glasses" | "simulated" | "phone";

export interface PhotoSource {
  kind: SourceKind;
  /** Get ready to capture (connect, permissions). Idempotent. */
  prepare(): Promise<void>;
  capture(): Promise<GlassesPhoto>;
  /** Release the camera (turns the glasses' capture LED off). */
  release(): Promise<void>;
}

/** Which sources this build can offer, best first. */
export function availableSources(): SourceKind[] {
  if (Glasses.availability().status !== "available") return ["phone"];
  // MockDeviceKit is compiled only into development builds (eas.json).
  return Glasses.getStatus()?.mockDeviceAvailable
    ? ["glasses", "simulated", "phone"]
    : ["glasses", "phone"];
}

const phone: PhotoSource = {
  kind: "phone",
  async prepare() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      throw new Error("Camera access is off for this app in Settings.");
    }
  },
  async capture() {
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.7,
      exif: false,
    });
    const asset = r.canceled ? undefined : r.assets[0];
    if (!asset) throw new Error("No photo taken.");
    return {
      uri: asset.uri,
      mimeType: asset.mimeType ?? "image/jpeg",
      width: asset.width,
      height: asset.height,
    };
  },
  async release() {},
};

function viaModule(kind: "glasses" | "simulated"): PhotoSource {
  return {
    kind,
    async prepare() {
      if (kind === "simulated") {
        const ok = await Glasses.enableMockDevice({ usePhoneCamera: true });
        if (!ok) {
          throw new Error(
            "This build has no simulated glasses (GLASSES_MOCK_DEVICE=false).",
          );
        }
      }
      const status = await Glasses.initialize();
      if (status.registration !== "registered") {
        await Glasses.register();
        throw new Error(
          "Finish connecting in the Meta AI app, then come back and try again.",
        );
      }
      await Glasses.connect();
    },
    capture: () => Glasses.capturePhoto(),
    async release() {
      await Glasses.disconnect();
      if (kind === "simulated") await Glasses.disableMockDevice();
    },
  };
}

export function photoSource(kind: SourceKind): PhotoSource {
  return kind === "phone" ? phone : viaModule(kind);
}
