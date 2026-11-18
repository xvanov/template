// Config plugin slot for the glasses module (see ../README.md).
//
// A no-op today, registered in app.config.ts so the wiring already exists:
// when a native SDK is added, this is where its build-time needs go (iOS
// Info.plist keys such as NSBluetoothAlwaysUsageDescription and the SDK's
// app id, Android manifest permissions and Maven repositories), via
// withInfoPlist / withAndroidManifest from "expo/config-plugins".
// Plain JS on purpose: the Expo CLI loads plugins with Node, untranspiled.

/** @param {import("expo/config").ExpoConfig} config */
module.exports = function withGlasses(config) {
  return config;
};
