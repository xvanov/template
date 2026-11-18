# modules/glasses: the slot for smart-glasses support

A typed JS API (`index.ts`, contract in `src/types.ts`) with no native code
yet. Everywhere today, `availability()` returns
`{ status: "unavailable", reason: ... }` and the actions throw
`GlassesUnavailableError`, so app code can be written against it now and
works unchanged in Expo Go, on web and in builds without the SDK.

Also registered: a no-op config plugin, `plugin/with-glasses.js`, in
`app.config.ts`'s `plugins`.

## Adding the native side (part 4c: Meta Wearables Device Access Toolkit)

1. Turn this folder into a local Expo module: add `expo-module.config.json`

   ```json
   {
     "platforms": ["apple", "android"],
     "apple": { "modules": ["GlassesModule"] },
     "android": { "modules": ["expo.modules.glasses.GlassesModule"] }
   }
   ```

   plus `ios/` (a podspec and `GlassesModule.swift`) and `android/`
   (`build.gradle` and `GlassesModule.kt`). `npx create-expo-module@latest
--local` generates that skeleton; keep this `index.ts` and `src/types.ts`
   and delete the generated JS. Expo autolinks modules under `modules/`; do
   NOT add `expo-module.config.json` before the native folders exist, or
   prebuild fails looking for them.

2. In the native module, `Name("Glasses")` and implement the functions in
   `GlassesNativeModule` (`isSupported`, `connect`, `disconnect`,
   `capturePhoto`), resolving photos to a local file `uri`.
3. Put the SDK's build needs (Info.plist Bluetooth/usage strings, the Meta app
   id, Android permissions, Maven repository) in `plugin/with-glasses.js`.
4. It needs a dev client build (`eas build --profile development`). Expo Go
   never has it; that is what `reason: "no_native_module"` is for.
