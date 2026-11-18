# modules/glasses: Meta glasses (Ray-Ban Meta, Oakley Meta, Meta Ray-Ban Display)

A local Expo module that wraps Meta's **Wearables Device Access Toolkit**
(DAT): connect to the glasses, stream their camera, capture photos. Plus the
pieces around it in this template:

| What                                | Where                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| Typed JS API (works everywhere)     | `index.ts`, contract in `src/types.ts`                             |
| Android (Kotlin, compiled + built)  | `android/` — DAT from Maven Central                                |
| iOS (Swift, **not compiled here**)  | `ios/` — DAT as a Swift Package via `spm_dependency`               |
| Config plugin (opt-in)              | `plugin/with-glasses.js`                                           |
| Capture → upload → describe → speak | `app/glasses.tsx`, `lib/glasses/*`                                 |
| AI description of a photo           | `ai.describeImage` (packages/api), images in `ask()` (packages/ai) |
| Glanceable page for Display glasses | `/glance/<link>` + `/app/glasses` (apps/web)                       |

Everything is **off by default**. With `GLASSES_ENABLED` unset, the config
plugin excludes this module from autolinking: a default build compiles and
ships exactly what it did before, downloads nothing from Meta, and
`availability()` returns `{ status: "unavailable", reason: "no_native_module" }`
(the capture screen then uses the phone camera).

## Enable it

1. Root `.env` (or EAS environment variables for cloud builds):

   ```bash
   GLASSES_ENABLED=true
   # Developer Mode needs no credentials ("0"). For release channels / testers:
   # GLASSES_META_APP_ID=…   GLASSES_CLIENT_TOKEN=…   (Wearables Developer Center)
   # GLASSES_MOCK_DEVICE=true    # simulated glasses; eas.json sets it for the
   #                             # development profiles only (default off)
   # GLASSES_IOS_EXPERIMENTAL=1  # iOS is refused without this (see below)
   ```

2. Build a dev client (Expo Go can never load this module):

   ```bash
   cd apps/mobile
   npx eas build --profile development --platform android   # or ios (device build)
   # or locally: npx expo prebuild --clean && npx expo run:android
   ```

   The plugin raises Android `minSdk` to 29 and the iOS deployment target to
   17.2 (the DAT's minimums) only in this build, and forces every
   `com.facebook.fresco` artifact to one version: the DAT's `mwdat-core` pulls
   Fresco fbcore 3.7.0 while React Native ships 3.6.0, and the mix crashes at
   launch with `NoSuchMethodError`.

   **iOS is opt-in twice**: with the flag on, an iOS prebuild/build fails with
   a message unless `GLASSES_IOS_EXPERIMENTAL=1`, because the Swift side has
   never been compiled. Android needs nothing extra.

3. On the phone: the **Meta AI app** (v292+ for DAT 1.0.1), the glasses paired
   in it, glasses firmware v128+, and **Developer Mode** on (Meta AI app →
   Settings → App Info → tap the version 5 times → toggle). Open the app's
   **Glasses** screen, pick "Glasses", tap Capture: the first time it sends you
   to the Meta AI app to connect the app, then to grant camera access.

### Without glasses (hackathon path)

- **Simulated glasses** (a GLASSES_ENABLED build with GLASSES_MOCK_DEVICE=true,
  no hardware): Meta's MockDeviceKit pairs a fake Ray-Ban Meta that is
  registered, permitted and worn, with the **phone's back camera as the
  glasses' camera**. The real DAT session/stream/capture code runs.
  `enableMockDevice()` in JS; the screen offers it only when
  `getStatus().mockDeviceAvailable`. Kept out of preview/production builds.
- **Phone camera** (any build, Expo Go included): `expo-image-picker` stands in
  for the glasses; upload → describe → speak is identical.

## JS API (`index.ts`)

```ts
import * as Glasses from "../modules/glasses";

Glasses.availability(); // { status: "available" } | { status: "unavailable", reason }
await Glasses.initialize(); // Bluetooth permission + SDK start → GlassesStatus
await Glasses.register(); // opens Meta AI to link this app (once)
await Glasses.connect(); // session + camera stream (asks camera permission)
const photo = await Glasses.capturePhoto(); // { uri: "file://….jpg", mimeType }
await Glasses.disconnect(); // camera off → capture LED off
await Glasses.enableMockDevice({ usePhoneCamera: true }); // simulated glasses
Glasses.addStatusListener((s) => s.registration /* , s.stream, … */);
```

Unavailable → every action rejects with `GlassesUnavailableError`. Native
failures reject with a coded error (`ERR_GLASSES_NOT_REGISTERED`,
`ERR_GLASSES_PERMISSION_DENIED`, `ERR_GLASSES_SESSION`, `ERR_GLASSES_CAMERA`,
`ERR_GLASSES_CAPTURE`, …).

**Audio**: no SDK needed. Paired glasses are an ordinary Bluetooth headset:
`expo-speech` (used by the capture screen) plays through their open-ear
speakers over A2DP, and the existing dictation records from the glasses'
microphones when the OS routes input to them (HFP: voice quality, 8/16 kHz;
it switches the glasses out of A2DP while active). The DAT also offers
in-band stream audio and on-device speech (`mwdat-speech`), both
**experimental** in 1.0 — Meta says apps using experimental features cannot
be published yet — so they are not wrapped here.

## Meta Ray-Ban Display: the glance page

Display glasses run **Web Apps**: plain HTML/CSS/JS from a public HTTPS URL,
in a Chromium-based browser on the glasses, driven by the Neural Band as a
D-pad (arrows + Enter). They cannot use the camera or microphone (that is the
DAT's job). `/glance/<gl_…>` in apps/web is one: approvals waiting and
unhandled inbox, ~5 KB, no framework bundle, black background (black is
transparent on the additive display), focusable rows, refreshes each minute.

Signing in on the glasses is impractical (Meta's docs say as much), so the
page is reached by a **glance link**: a revocable secret URL that can read
that snapshot and nothing else, acts as its creator, and stops working when
the creator leaves the org. Make one at **/app/glasses** on the web app, then
either tap "Add to glasses" on the phone (the `fb-viewapp://web_app_deep_link`
deep link into the Meta AI app) or add it by hand: Meta AI app → App settings
→ Apps → Web Apps → Connect Web App. Needs Developer Mode, glasses v125+, Meta
AI app v272+, and the web app reachable over HTTPS (e.g. Tailscale serve, a
tunnel, or production). Preview locally with Meta's "Meta Ray-Ban Display
Simulator" Chrome extension (600×600, additive blending, D-pad).

## Privacy and Meta's rules

- The glasses light a **capture LED** whenever the camera streams. Never try
  to hide or obscure it, never record covertly, and avoid sensitive places —
  all prohibited by Meta's Acceptable Use Policy. `disconnect()` as soon as you
  are done; the capture screen does on leave.
- **No identification of people** from faces or voices (prohibited without
  Meta's prior approval). The describe prompt (`ai.describeImage`) instructs
  the model never to identify anyone.
- Photos go to the tenant's media library like any upload (org-scoped,
  deletable) and, only if "Describe with AI" is on, to the configured LLM
  provider as a capped, `discretionary` call recorded in `llm_call`. Tell your
  users which provider sees their photos.
- Photos are shrunk on the phone to ≤ 1568 px (JPEG 0.8) before upload, and
  the local copies are deleted once uploaded. The server refuses to describe
  anything over 3.75 MB (Anthropic's 5 MB base64 limit).
- The SDK sends Meta usage analytics and crash reports unless opted out; this
  template opts out of both by default (`GLASSES_ANALYTICS_OPT_OUT`,
  `GLASSES_CRASH_REPORTING_OPT_OUT`).
- A glance link is a password in a URL: `no-store`, `no-referrer`, `noindex`
  are set, it is stored hashed, and it can be revoked at /app/glasses. The
  URL (secret included) can still land in **access logs** of anything in
  between: a reverse proxy, a tunnel (Cloudflare, ngrok, Tailscale Funnel),
  `next dev`'s request log. So links expire (30 days by default, chosen per
  link) and show **counts only** by default ("3 waiting for approval"); titles
  and senders are opt-in per link, because they also appear on a see-through
  display in public.

## What is verified, and what is not (DAT 1.0.1, November 2026)

Verified here:

- The config plugin, both ways: `expo prebuild` with and without
  `GLASSES_ENABLED` (Info.plist, manifest, gradle/Podfile properties,
  autolinking exclusion), plus snapshot tests (`plugin/with-glasses.test.ts`).
- Android: the module compiles against the real DAT 1.0.1 artifacts and a
  full `assembleDebug` of the app succeeds with it linked (with and without
  MockDeviceKit). The default build does not link it.
- **Android emulator, end to end** (API 35, release build, flag + mock on):
  the app launches; "Simulated glasses" → Capture asks for camera and
  nearby-devices permission, MockDeviceKit registers and streams (status
  `registered · glasses: 1 · camera: streaming · simulated`), the photo
  (480×640 from the emulator's virtual camera) uploads, `ai.describeImage`
  sends it to an OpenAI-compatible vision endpoint (a local stub) as an image
  part, the description shows and is spoken (Google TTS), a second capture
  works, the cache holds no JPEGs afterwards, and Disconnect stops the stream.
- The JS fallbacks, the pipeline and the server side (tests).

Not verified (no device, no macOS):

- **Anything on real glasses** (registration through the Meta AI app, real
  camera permission, Bluetooth/Wi-Fi transport, speakers on the glasses).
- **iOS does not compile here**: `ios/` is written against the documented
  Swift API (docs + Meta's CameraAccess sample) but needs Xcode 26.4+ on
  macOS. Expect small fixes on the first build; keep it in step with Android.
- The registration callback: the Meta AI app returns on `APP_SCHEME` with
  `?metaWearablesAction=…`. iOS hands it to the SDK in
  `GlassesAppDelegateSubscriber`; on Android the SDK appears to handle its own
  flow (Meta's sample forwards nothing) and the module also passes such
  intents to `Wearables.handleIntent`; `app/+native-intent.tsx` routes them to
  the glasses screen.
- The Display glance page on actual Display glasses.

## Limits to know

- **App Store**: Meta states publishing DAT apps to the App Store is not
  supported yet (the SDK's ExternalAccessory use fails Apple's MFi review).
  Distribute through Meta's release channels (invite-only testers) plus
  TestFlight/internal builds. Publishing to all users is "coming".
- Developer Mode allows **one** third-party app registered at a time.
- Only in AI-glasses-supported countries do you get the Developer Center.
- Upgrading the DAT: change `GLASSES_DAT_VERSION`, read Meta's CHANGELOG
  (0.9 → 1.0 had breaking API changes), rebuild both platforms.
