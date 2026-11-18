// Config plugin for the glasses module (Meta Wearables Device Access Toolkit).
// See ../README.md. Plain CommonJS on purpose: the Expo CLI loads plugins with
// Node, untranspiled.
//
// OFF (the default, GLASSES_ENABLED unset/false): the native module is
// EXCLUDED from autolinking, so a default build compiles and ships exactly
// what it did before this module existed. Nothing of Meta's is downloaded.
//
// ON: the module is linked and the build gets what the DAT needs:
//   iOS      MWDAT dict (app id, client token, callback scheme, analytics
//            opt-out), Bluetooth + external-accessory background modes, the
//            accessory protocol, Bluetooth/local-network usage strings, and
//            a deployment target of at least 17.2.
//   Android  Bluetooth permissions, the APPLICATION_ID / CLIENT_TOKEN /
//            opt-out meta-data, minSdk at least 29, gradle properties the
//            module's build.gradle reads (SDK version, MockDeviceKit on/off),
//            and ONE Fresco version for the whole app (see alignFresco).
//
// iOS is refused with the flag on unless GLASSES_IOS_EXPERIMENTAL=1: the
// Swift side has never been compiled (no macOS here), so a build must opt
// in knowingly. Android is unaffected (iOS mods only run for iOS).
//
// The pure `apply*` functions are exported for the unit tests
// (./with-glasses.test.ts snapshots their output).

const {
  AndroidConfig,
  withAndroidManifest,
  withGradleProperties,
  withInfoPlist,
  withPodfile,
  withPodfileProperties,
  withProjectBuildGradle,
  withSettingsGradle,
} = require("expo/config-plugins");

/** The autolinking name of ../ (the folder name; there is no package.json). */
const MODULE_NAME = "glasses";
const DEFAULT_DAT_VERSION = "1.0.1";
const MIN_IOS = "17.2";
const MIN_ANDROID_SDK = 29;
/**
 * The DAT's mwdat-core depends on Fresco fbcore 3.7.0; React Native 0.86 ships
 * the rest of Fresco at 3.6.0. Gradle then resolves fbcore alone to 3.7.0 and
 * the app dies at launch with NoSuchMethodError. Every com.facebook.fresco
 * artifact is forced to one version: the higher of React Native's and this.
 */
const DAT_FRESCO_VERSION = "3.7.0";
const DAT_META = "com.meta.wearable.mwdat";

/**
 * @typedef {object} GlassesOptions
 * @property {boolean} enabled
 * @property {string} metaAppId   "0" = Developer Mode (no attestation)
 * @property {string} clientToken "0" = Developer Mode
 * @property {boolean} mockDevice  compile MockDeviceKit in (simulated glasses)
 * @property {boolean} analyticsOptOut
 * @property {boolean} crashReportingOptOut
 * @property {boolean} iosExperimental  allow an iOS build (Swift unverified)
 * @property {string} datVersion
 */

/** @returns {GlassesOptions} */
function resolveOptions(props = {}) {
  const truthy = (v, fallback) =>
    v === undefined || v === null || v === ""
      ? fallback
      : v === true || /^(1|true|yes|on)$/i.test(String(v).trim());
  const str = (v, fallback) =>
    v === undefined || v === null || String(v).trim() === ""
      ? fallback
      : String(v).trim();
  const datVersion = str(props.datVersion, DEFAULT_DAT_VERSION);
  if (!/^\d+\.\d+\.\d+$/.test(datVersion)) {
    throw new Error(
      `with-glasses: datVersion "${datVersion}" is not a plain x.y.z version.`,
    );
  }
  return {
    enabled: truthy(props.enabled, false),
    metaAppId: str(props.metaAppId, "0"),
    clientToken: str(props.clientToken, "0"),
    // Off unless asked for: eas.json turns it on for the development
    // profiles only, so tester/production builds never carry fake glasses.
    mockDevice: truthy(props.mockDevice, false),
    analyticsOptOut: truthy(props.analyticsOptOut, true),
    crashReportingOptOut: truthy(props.crashReportingOptOut, true),
    iosExperimental: truthy(props.iosExperimental, false),
    datVersion,
  };
}

// ── iOS ──────────────────────────────────────────────────────────────────

function addUnique(list, values) {
  const out = Array.isArray(list) ? [...list] : [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

/** Info.plist entries from the DAT's iOS integration guide (v1.0). */
function applyInfoPlist(plist, opts, { scheme, appName }) {
  if (!scheme) {
    throw new Error(
      "with-glasses: the app needs a `scheme`: Meta AI calls the app back on it.",
    );
  }
  const next = { ...plist };
  next.MWDAT = {
    ...(plist.MWDAT ?? {}),
    AppLinkURLScheme: `${scheme}://`,
    MetaAppID: opts.metaAppId,
    ClientToken: opts.clientToken,
    TeamID: "$(DEVELOPMENT_TEAM)",
    Analytics: { OptOut: opts.analyticsOptOut },
    CrashReporting: { OptOut: opts.crashReportingOptOut },
  };
  // Bluetooth LE (both roles), Bluetooth Classic via ExternalAccessory (camera
  // streaming), and Wi-Fi (high bandwidth) — the SDK checks each before use.
  next.UIBackgroundModes = addUnique(plist.UIBackgroundModes, [
    "bluetooth-central",
    "bluetooth-peripheral",
    "external-accessory",
    "processing",
  ]);
  next.UISupportedExternalAccessoryProtocols = addUnique(
    plist.UISupportedExternalAccessoryProtocols,
    ["com.meta.ar.wearable"],
  );
  next.NSBluetoothAlwaysUsageDescription =
    plist.NSBluetoothAlwaysUsageDescription ??
    `${appName} connects to your Meta AI glasses over Bluetooth.`;
  next.NSLocalNetworkUsageDescription =
    plist.NSLocalNetworkUsageDescription ??
    `${appName} finds and connects to your glasses over Wi-Fi.`;
  next.NSBonjourServices = addUnique(plist.NSBonjourServices, [
    "_bonjour._tcp",
  ]);
  if (opts.mockDevice) {
    // MockDeviceKit can use the phone's own camera as the "glasses" feed.
    next.NSCameraUsageDescription =
      plist.NSCameraUsageDescription ??
      `${appName} uses the camera to simulate glasses while testing.`;
  }
  return next;
}

/** Raise (never lower) a dotted version. */
function atLeast(current, min) {
  if (!current) return min;
  const a = String(current).split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? String(current) : min;
  }
  return String(current);
}

/** Read by ../ios/Glasses.podspec (SDK version, MockDeviceKit on/off). */
function applyPodfileProperties(props, opts) {
  return {
    ...props,
    "ios.deploymentTarget": atLeast(props["ios.deploymentTarget"], MIN_IOS),
    "glasses.datVersion": opts.datVersion,
    "glasses.mockDevice": String(opts.mockDevice),
  };
}

/**
 * Off: `use_expo_modules!` → `use_expo_modules!(exclude: ['glasses'])`.
 * Throws if the template changed shape, so an Expo upgrade fails loudly at
 * prebuild instead of silently linking (and downloading) the SDK.
 */
function excludeFromPodfile(src) {
  if (src.includes(`exclude: ['${MODULE_NAME}']`)) return src;
  const re = /^([ \t]*)use_expo_modules![ \t]*$/m;
  if (!re.test(src)) {
    throw new Error(
      "with-glasses: no bare `use_expo_modules!` line in ios/Podfile; update excludeFromPodfile for this Expo SDK.",
    );
  }
  return src.replace(re, `$1use_expo_modules!(exclude: ['${MODULE_NAME}'])`);
}

// ── Android ──────────────────────────────────────────────────────────────

const ANDROID_PERMISSIONS = [
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.INTERNET",
];

function applyAndroidManifest(manifest, opts) {
  const permissions = opts.mockDevice
    ? [...ANDROID_PERMISSIONS, "android.permission.CAMERA"]
    : ANDROID_PERMISSIONS;
  AndroidConfig.Permissions.ensurePermissions(manifest, permissions);
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const meta = {
    [`${DAT_META}.APPLICATION_ID`]: opts.metaAppId,
    [`${DAT_META}.CLIENT_TOKEN`]: opts.clientToken,
    [`${DAT_META}.ANALYTICS_OPT_OUT`]: String(opts.analyticsOptOut),
    [`${DAT_META}.CRASH_REPORTING_OPT_OUT`]: String(opts.crashReportingOptOut),
  };
  for (const [name, value] of Object.entries(meta)) {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, name, value);
  }
  return manifest;
}

function setGradleProperty(props, key, value) {
  const existing = props.find((p) => p.type === "property" && p.key === key);
  if (existing) existing.value = value;
  else props.push({ type: "property", key, value });
}

function applyGradleProperties(props, opts) {
  const next = props.map((p) => ({ ...p }));
  const min = next.find(
    (p) => p.type === "property" && p.key === "android.minSdkVersion",
  );
  const current = min ? Number.parseInt(min.value, 10) : 0;
  if (!(current >= MIN_ANDROID_SDK)) {
    setGradleProperty(next, "android.minSdkVersion", String(MIN_ANDROID_SDK));
  }
  setGradleProperty(next, "glasses.datVersion", opts.datVersion);
  setGradleProperty(next, "glasses.mockDevice", String(opts.mockDevice));
  return next;
}

/** Compare dotted versions; returns the higher. */
function maxVersion(a, b) {
  return atLeast(a, b);
}

/** React Native's Fresco version, from its own version catalog. */
function reactNativeFrescoVersion(projectRoot) {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const rn = path.dirname(
      require.resolve("react-native/package.json", { paths: [projectRoot] }),
    );
    const toml = fs.readFileSync(
      path.join(rn, "gradle", "libs.versions.toml"),
      "utf8",
    );
    return /^fresco\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch {
    return null;
  }
}

const FRESCO_MARKER = "// glasses: one Fresco version";

/** On: force every com.facebook.fresco artifact to `version` (root build.gradle). */
function alignFresco(src, version) {
  if (src.includes(FRESCO_MARKER)) return src;
  return `${src.trimEnd()}

${FRESCO_MARKER} (modules/glasses/plugin/with-glasses.js).
// Meta's DAT pulls Fresco fbcore ${DAT_FRESCO_VERSION}; mixing it with React
// Native's other Fresco artifacts crashes at launch (NoSuchMethodError).
allprojects {
  configurations.configureEach {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == "com.facebook.fresco") {
        details.useVersion("${version}")
        details.because("one Fresco version for React Native and the Meta DAT")
      }
    }
  }
}
`;
}

/** Off: set `expoAutolinking.exclude` before `useExpoModules()`. */
function excludeFromSettingsGradle(src) {
  if (src.includes(`expoAutolinking.exclude = ["${MODULE_NAME}"]`)) return src;
  const re = /^([ \t]*)expoAutolinking\.useExpoModules\(\)[ \t]*$/m;
  if (!re.test(src)) {
    throw new Error(
      "with-glasses: no `expoAutolinking.useExpoModules()` line in android/settings.gradle; update excludeFromSettingsGradle for this Expo SDK.",
    );
  }
  return src.replace(
    re,
    `$1// GLASSES_ENABLED is off: keep the glasses module (and Meta's SDK) out.\n$1expoAutolinking.exclude = ["${MODULE_NAME}"]\n$1expoAutolinking.useExpoModules()`,
  );
}

// ── the plugin ───────────────────────────────────────────────────────────

/** @param {import("expo/config").ExpoConfig} config */
function withGlasses(config, props) {
  const opts = resolveOptions(props);

  if (!opts.enabled) {
    config = withPodfile(config, (c) => {
      c.modResults.contents = excludeFromPodfile(c.modResults.contents);
      return c;
    });
    config = withSettingsGradle(config, (c) => {
      c.modResults.contents = excludeFromSettingsGradle(c.modResults.contents);
      return c;
    });
    return config;
  }

  const iosRefusal = () => {
    if (!opts.iosExperimental) {
      throw new Error(
        "with-glasses: GLASSES_ENABLED is on, but the iOS side of the glasses module has never been compiled. " +
          "Build Android, or set GLASSES_IOS_EXPERIMENTAL=1 to try iOS anyway (needs Xcode 26.4+; expect fixes; see modules/glasses/README.md).",
      );
    }
  };
  const scheme = Array.isArray(config.scheme)
    ? config.scheme[0]
    : config.scheme;
  config = withInfoPlist(config, (c) => {
    iosRefusal();
    c.modResults = applyInfoPlist(c.modResults, opts, {
      scheme,
      appName: config.name,
    });
    return c;
  });
  config = withPodfileProperties(config, (c) => {
    c.modResults = applyPodfileProperties(c.modResults, opts);
    return c;
  });
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyAndroidManifest(c.modResults, opts);
    return c;
  });
  config = withGradleProperties(config, (c) => {
    c.modResults = applyGradleProperties(c.modResults, opts);
    return c;
  });
  config = withProjectBuildGradle(config, (c) => {
    const rn = reactNativeFrescoVersion(c.modRequest.projectRoot);
    c.modResults.contents = alignFresco(
      c.modResults.contents,
      rn ? maxVersion(rn, DAT_FRESCO_VERSION) : DAT_FRESCO_VERSION,
    );
    return c;
  });
  return config;
}

module.exports = withGlasses;
module.exports.resolveOptions = resolveOptions;
module.exports.applyInfoPlist = applyInfoPlist;
module.exports.applyPodfileProperties = applyPodfileProperties;
module.exports.excludeFromPodfile = excludeFromPodfile;
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.applyGradleProperties = applyGradleProperties;
module.exports.excludeFromSettingsGradle = excludeFromSettingsGradle;
module.exports.alignFresco = alignFresco;
module.exports.reactNativeFrescoVersion = reactNativeFrescoVersion;
