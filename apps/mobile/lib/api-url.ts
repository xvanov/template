import Constants from "expo-constants";

/**
 * The origin the phone should dial.
 *
 * `localhost` means "this phone" on a physical device, so it can never reach a
 * dev server on your laptop. When EXPO_PUBLIC_API_URL is unset or still points
 * at localhost, we derive the LAN address from the Expo dev server the app was
 * loaded from — which is by definition reachable from the device.
 *
 * In a real build, set EXPO_PUBLIC_API_URL to your public https origin.
 */
export const API_PORT = 3200;

export function getBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv && !/localhost|127\.0\.0\.1/.test(fromEnv)) {
    return fromEnv.replace(/\/$/, "");
  }

  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Older/other runtimes expose it here instead.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)
      ?.debuggerHost;

  const host = hostUri?.split(":")[0];
  if (host) return `http://${host}:${API_PORT}`;

  // Simulator / web fallback.
  return fromEnv?.replace(/\/$/, "") ?? `http://localhost:${API_PORT}`;
}
