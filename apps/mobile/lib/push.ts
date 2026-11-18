/**
 * Push notifications on the device: permission, the Expo push token, and the
 * Android channel. The server side is push.register / push.unregister
 * (packages/api) and @repo/push-mobile.
 *
 * NEEDS A DEV CLIENT OR STORE BUILD. Expo Go cannot receive remote pushes for
 * your project (removed on Android in SDK 53), so in Expo Go this reports
 * "expo_go" and does nothing; expo-notifications is not even loaded there
 * (dynamic import), which keeps Expo Go's warning about it out of the log.
 * A token also needs a physical device and EAS_PROJECT_ID (app.config.ts).
 */
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export type PushSupport =
  | { ok: true }
  | {
      ok: false;
      reason: "expo_go" | "simulator" | "web" | "no_project_id";
      message: string;
    };

const TOKEN_KEY = "push.token";

export function pushSupport(): PushSupport {
  if (Platform.OS === "web")
    return { ok: false, reason: "web", message: "Not available on web." };
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    return {
      ok: false,
      reason: "expo_go",
      message:
        "Expo Go cannot receive this app's pushes. Use a development build (eas build --profile development).",
    };
  if (!Device.isDevice)
    return {
      ok: false,
      reason: "simulator",
      message: "Push tokens need a physical device.",
    };
  if (!projectId())
    return {
      ok: false,
      reason: "no_project_id",
      message: "EAS_PROJECT_ID is not set for this build (run eas init).",
    };
  return { ok: true };
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as
    { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

let handlerSet = false;

/**
 * Ask for permission (once; the OS remembers the answer) and get this
 * install's Expo push token. Null when unsupported or denied.
 */
export async function obtainPushToken(): Promise<
  | { token: string; platform: "ios" | "android" }
  | { token: null; reason: string }
> {
  const support = pushSupport();
  if (!support.ok) return { token: null, reason: support.message };
  const Notifications = await import("expo-notifications");

  if (!handlerSet) {
    handlerSet = true;
    // Shown even while the app is open: the user may be on another screen.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  }
  if (Platform.OS === "android") {
    // The server sends to channelId "default" (packages/push-mobile).
    await Notifications.setNotificationChannelAsync("default", {
      name: "Notifications",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== "granted")
    return {
      token: null,
      reason: "Notifications are turned off for this app in Settings.",
    };

  const { data } = await Notifications.getExpoPushTokenAsync({
    projectId: projectId(),
  });
  await SecureStore.setItemAsync(TOKEN_KEY, data).catch(() => {});
  return { token: data, platform: Platform.OS === "ios" ? "ios" : "android" };
}

/** The token last registered from this install, for sign-out. */
export async function storedPushToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function forgetPushToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}
