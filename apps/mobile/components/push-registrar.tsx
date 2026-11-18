import { useEffect } from "react";
import { router } from "expo-router";

import { useSession } from "../lib/auth";
import { onPushTapped } from "../lib/push";
import { routeForPush } from "../lib/push-route";
import { usePushRegistration } from "../lib/use-push";

/**
 * Registers this install for push once signed in, and opens what a tapped
 * notification is about (a proposal, a message). Renders nothing.
 */
export function PushRegistrar() {
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user);
  usePushRegistration(signedIn);

  useEffect(() => {
    if (!signedIn) return;
    let stop = () => {};
    let cancelled = false;
    void onPushTapped((data) => {
      const to = routeForPush(data);
      if (to) router.push(to);
    }).then((unsubscribe) => {
      if (cancelled) unsubscribe();
      else stop = unsubscribe;
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [signedIn]);

  return null;
}
