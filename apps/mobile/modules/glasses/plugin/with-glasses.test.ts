/**
 * The config plugin's output, snapshotted: what a GLASSES_ENABLED build gets
 * in Info.plist, AndroidManifest.xml, gradle.properties and
 * Podfile.properties.json, and how a default build keeps the module out of
 * autolinking. (Proven end to end by `GLASSES_ENABLED=true npx expo prebuild`
 * and a Gradle build; see ../README.md.)
 */
import { describe, expect, it } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("./with-glasses") as {
  resolveOptions: (p?: Record<string, unknown>) => Record<string, unknown>;
  applyInfoPlist: (
    plist: Record<string, unknown>,
    opts: unknown,
    ctx: { scheme?: string; appName: string },
  ) => Record<string, unknown>;
  applyPodfileProperties: (
    p: Record<string, string>,
    opts: unknown,
  ) => Record<string, string>;
  applyAndroidManifest: (m: unknown, opts: unknown) => unknown;
  applyGradleProperties: (
    p: { type: string; key?: string; value?: string }[],
    opts: unknown,
  ) => { type: string; key?: string; value?: string }[];
  excludeFromPodfile: (src: string) => string;
  excludeFromSettingsGradle: (src: string) => string;
};

const ON = plugin.resolveOptions({ enabled: "true" });

describe("resolveOptions", () => {
  it("is off by default, Developer Mode credentials, mock + opt-out on", () => {
    expect(plugin.resolveOptions()).toEqual({
      enabled: false,
      metaAppId: "0",
      clientToken: "0",
      mockDevice: true,
      analyticsOptOut: true,
      datVersion: "1.0.1",
    });
  });

  it("reads env-style strings, and rejects a version that is not x.y.z", () => {
    expect(
      plugin.resolveOptions({
        enabled: "1",
        metaAppId: " 123 ",
        mockDevice: "false",
        analyticsOptOut: "no",
        datVersion: "1.1.0",
      }),
    ).toMatchObject({
      enabled: true,
      metaAppId: "123",
      mockDevice: false,
      analyticsOptOut: false,
      datVersion: "1.1.0",
    });
    expect(() => plugin.resolveOptions({ datVersion: "latest" })).toThrow(
      /x\.y\.z/,
    );
  });
});

describe("enabled: iOS", () => {
  it("Info.plist", () => {
    const plist = plugin.applyInfoPlist(
      {
        UIBackgroundModes: ["remote-notification"],
        NSBonjourServices: ["_expo._tcp"],
        NSCameraUsageDescription: "Existing camera text.",
      },
      ON,
      { scheme: "apptemplate", appName: "App Template" },
    );
    expect(plist).toMatchSnapshot();
  });

  it("needs a scheme: Meta AI calls the app back on it", () => {
    expect(() => plugin.applyInfoPlist({}, ON, { appName: "x" })).toThrow(
      /scheme/,
    );
  });

  it("Podfile.properties.json raises (never lowers) the deployment target", () => {
    expect(plugin.applyPodfileProperties({}, ON)).toMatchSnapshot();
    expect(
      plugin.applyPodfileProperties({ "ios.deploymentTarget": "18.0" }, ON)[
        "ios.deploymentTarget"
      ],
    ).toBe("18.0");
  });
});

describe("enabled: Android", () => {
  it("AndroidManifest.xml", () => {
    const manifest = {
      manifest: {
        $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
        "uses-permission": [
          { $: { "android:name": "android.permission.INTERNET" } },
        ],
        application: [{ $: { "android:name": ".MainApplication" } }],
      },
    };
    expect(plugin.applyAndroidManifest(manifest, ON)).toMatchSnapshot();
  });

  it("gradle.properties raises minSdk to 29 and passes the SDK settings", () => {
    const props = plugin.applyGradleProperties(
      [
        { type: "comment", value: "x" },
        { type: "property", key: "newArchEnabled", value: "true" },
      ],
      ON,
    );
    expect(props).toMatchSnapshot();
    const kept = plugin.applyGradleProperties(
      [{ type: "property", key: "android.minSdkVersion", value: "31" }],
      ON,
    );
    expect(kept.find((p) => p.key === "android.minSdkVersion")?.value).toBe(
      "31",
    );
  });
});

describe("disabled: the module stays out of autolinking", () => {
  // The lines as Expo SDK 57's prebuild templates write them.
  const PODFILE = "target 'AppTemplate' do\n  use_expo_modules!\n\n  if ENV\n";
  const SETTINGS =
    "}\nexpoAutolinking.useExpoModules()\n\nrootProject.name = 'App Template'\n";

  it("Podfile and settings.gradle", () => {
    const podfile = plugin.excludeFromPodfile(PODFILE);
    const settings = plugin.excludeFromSettingsGradle(SETTINGS);
    expect(podfile).toBe(
      "target 'AppTemplate' do\n  use_expo_modules!(exclude: ['glasses'])\n\n  if ENV\n",
    );
    expect(settings).toMatchSnapshot();
    // Idempotent: prebuild without --clean runs the mods again.
    expect(plugin.excludeFromPodfile(podfile)).toBe(podfile);
    expect(plugin.excludeFromSettingsGradle(settings)).toBe(settings);
  });

  it("fails loudly if an Expo upgrade changes the templates", () => {
    expect(() => plugin.excludeFromPodfile("use_expo_modules!(x)\n")).toThrow(
      /use_expo_modules/,
    );
    expect(() => plugin.excludeFromSettingsGradle("nothing here")).toThrow(
      /useExpoModules/,
    );
  });
});
