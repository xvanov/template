import { expoClient } from "@better-auth/expo/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

import { getBaseUrl } from "./api-url";

/**
 * The native auth client. Same server, same endpoints as the web app.
 *
 * The session cookie is kept in the OS keychain via SecureStore — never
 * AsyncStorage, which is plain text on a rooted device. `scheme` must match
 * `expo.scheme` in app.json or the OAuth browser hop cannot deep-link back.
 */
export const authClient = createAuthClient({
  baseURL: getBaseUrl(),
  plugins: [
    // @ts-expect-error Upstream typing gap, not a shortcut: as of better-auth
    // 1.6.25 the Expo plugin's `getActions` signature is not assignable to
    // `BetterAuthClientPlugin` (generic variance inside better-fetch). Runtime
    // behaviour is unaffected, and suppressing rather than casting keeps the
    // plugin's own types available for session inference. Remove once upstream
    // types line up.
    expoClient({
      scheme: "apptemplate",
      storagePrefix: "apptemplate",
      storage: SecureStore,
    }),
    organizationClient(),
  ],
});

/**
 * The stored session cookie, for hand-attaching to non-auth requests.
 *
 * React Native has no cookie jar, so the Expo plugin exposes the cookie it
 * keeps in SecureStore through this action; tRPC has to forward it explicitly.
 */
export function getSessionCookie(): string | null {
  const client = authClient as unknown as { getCookie?: () => string };
  return client.getCookie?.() ?? null;
}

export const { signIn, signUp, signOut, useSession } = authClient;
