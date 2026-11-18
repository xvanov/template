import { Image } from "expo-image";

import { authClient } from "./auth";
// @module:push-mobile
import { forgetPushToken, storedPushToken } from "./push";
import { trpc } from "./trpc";
import { resetPushState } from "./use-push";
// @end

/**
 * Sign out, and drop cached photos. Before that (while the session still
 * exists to authorise it), stop this device getting the account's pushes. // @module:push-mobile
 * Best effort: an offline sign-out still signs out.
 */
export function useSignOut(): () => Promise<void> {
  const { mutateAsync } = trpc.push.unregister.useMutation(); // @module:push-mobile
  return async () => {
    // @module:push-mobile
    // A failed unregister is fine: the row is dropped when someone else
    // registers the token, or disabled when Expo reports it dead.
    const token = await storedPushToken();
    if (token) {
      await mutateAsync({ token }).catch(() => {});
      await forgetPushToken();
    }
    resetPushState();
    // @end
    // Photos were fetched with this account's cookie: the next person on
    // this phone must not see them from the cache.
    await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]).catch(
      () => {},
    );
    await authClient.signOut();
  };
}
