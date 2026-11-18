/**
 * The Expo app config, dynamic so that renaming the app is ONE place: the
 * MOBILE_* variables (plus APP_SCHEME, shared with the server) in the root
 * .env, or in an EAS environment for cloud builds. The defaults below are the
 * template's; a real app sets the variables rather than editing this file.
 *
 *   MOBILE_APP_NAME      Name under the icon.                  "App Template"
 *   MOBILE_APP_SLUG      Expo/EAS project slug.                "app-template"
 *   MOBILE_BUNDLE_ID     iOS bundle id AND Android package.    "com.example.apptemplate"
 *   APP_SCHEME           Deep-link scheme (OAuth return).      "apptemplate"
 *   EAS_PROJECT_ID       From `eas init`; needed for push tokens and EAS builds.
 *   EXPO_OWNER           Expo account or org that owns the project (optional).
 *
 * Meta glasses (modules/glasses/README.md), all optional, all build-time: // @module:glasses
 *   GLASSES_ENABLED        Link the Meta Wearables SDK into the build.  false // @module:glasses
 *   GLASSES_META_APP_ID    Wearables Developer Center app id.           "0" (Developer Mode) // @module:glasses
 *   GLASSES_CLIENT_TOKEN   Its client token.                            "0" (Developer Mode) // @module:glasses
 *   GLASSES_MOCK_DEVICE    Compile MockDeviceKit (simulated glasses).   false (eas.json: on for development) // @module:glasses
 *   GLASSES_ANALYTICS_OPT_OUT  Opt out of Meta's SDK analytics.         true // @module:glasses
 *   GLASSES_CRASH_REPORTING_OPT_OUT  Opt out of its crash reports.      true // @module:glasses
 *   GLASSES_IOS_EXPERIMENTAL  Allow an iOS build (Swift unverified).    false // @module:glasses
 *   GLASSES_DAT_VERSION    Device Access Toolkit version.               1.0.1 // @module:glasses
 * // @module:glasses
 * APP_SCHEME is load-bearing: the OAuth browser hop deep-links back on it, and
 * the server lists `<scheme>://` in better-auth's trustedOrigins. Both sides
 * read the same variable, so they cannot disagree.
 *
 * The root .env is read here (variables already set win), because the Expo
 * CLI only loads .env files from apps/mobile and the repo keeps one .env at
 * the root. On EAS servers there is no .env (it is gitignored): set the same
 * variables as EAS environment variables (`eas env:create`) or in eas.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import type { ConfigContext, ExpoConfig } from "expo/config";

const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) {
  for (const [k, v] of Object.entries(
    parseEnv(readFileSync(rootEnv, "utf8")),
  )) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const e = (name: string, fallback: string): string =>
  process.env[name]?.trim() || fallback;

const NAME = e("MOBILE_APP_NAME", "App Template");
const SLUG = e("MOBILE_APP_SLUG", "app-template");
const BUNDLE_ID = e("MOBILE_BUNDLE_ID", "com.example.apptemplate");
const SCHEME = e("APP_SCHEME", "apptemplate");
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID?.trim() || undefined;
const OWNER = process.env.EXPO_OWNER?.trim() || undefined;

// Refuse values the stores and the OS would reject later, at a worse moment.
if (!/^[a-z][a-z0-9+.-]*$/.test(SCHEME)) {
  throw new Error(
    `APP_SCHEME="${SCHEME}" is not a valid URL scheme (lowercase letters, digits, + . -; starts with a letter).`,
  );
}
if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(BUNDLE_ID)) {
  throw new Error(
    `MOBILE_BUNDLE_ID="${BUNDLE_ID}" must be reverse-DNS, e.g. com.yourco.yourapp (letters, digits, _; no dashes, which Android refuses).`,
  );
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: NAME,
  slug: SLUG,
  ...(OWNER ? { owner: OWNER } : {}),
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  scheme: SCHEME,
  ios: {
    supportsTablet: true,
    bundleIdentifier: BUNDLE_ID,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    bundler: "metro",
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    "expo-status-bar",
    [
      // SDK 57 configures the native splash screen through this plugin only
      // (a top-level `splash` is no longer read).
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: { backgroundColor: "#16181d" },
      },
    ],
    // The dev client: `eas build --profile development`. Expo Go ignores it.
    "expo-dev-client",
    // @module:push-mobile
    [
      "expo-notifications",
      // Android's status-bar icon must be a white silhouette; replace this
      // with one (96x96 PNG, transparent background) when you rebrand.
      { icon: "./assets/android-icon-monochrome.png", color: "#4f46e5" },
    ],
    // @end
    [
      "expo-image-picker",
      {
        photosPermission: `Allow ${NAME} to attach photos you choose.`,
        cameraPermission: `Allow ${NAME} to take photos to attach.`,
        // Photos only: no video, so no microphone prompt from the picker.
        microphonePermission: false,
      },
    ],
    // @module:ai
    [
      "expo-audio",
      {
        microphonePermission: `Allow ${NAME} to record a voice note to transcribe.`,
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
      },
    ],
    // @end
    // @module:glasses
    // Meta glasses (modules/glasses/README.md). Off by default: the native
    // module is then left out of autolinking and the build is unchanged.
    [
      "./modules/glasses/plugin/with-glasses.js",
      {
        enabled: process.env.GLASSES_ENABLED,
        metaAppId: process.env.GLASSES_META_APP_ID,
        clientToken: process.env.GLASSES_CLIENT_TOKEN,
        mockDevice: process.env.GLASSES_MOCK_DEVICE,
        analyticsOptOut: process.env.GLASSES_ANALYTICS_OPT_OUT,
        crashReportingOptOut: process.env.GLASSES_CRASH_REPORTING_OPT_OUT,
        iosExperimental: process.env.GLASSES_IOS_EXPERIMENTAL,
        datVersion: process.env.GLASSES_DAT_VERSION,
      },
    ],
    // @end
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});
