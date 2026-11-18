import { useEffect, useSyncExternalStore } from "react";
import { obtainPushToken } from "./push";
import { trpc } from "./trpc";

export type PushState =
  | { status: "idle" | "registering" }
  | { status: "registered"; token: string }
  | { status: "unavailable"; reason: string }
  | { status: "error"; message: string };

// One registration per app start, shared by every screen that shows it.
let state: PushState = { status: "idle" };
const listeners = new Set<() => void>();
function setState(next: PushState) {
  state = next;
  listeners.forEach((l) => l());
}

/** This install's push registration, as last attempted. */
export function usePushState(): PushState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/**
 * Register this install for push once per app start while signed in (the
 * server treats a repeat as a heartbeat). Mounted once, in app/_layout.tsx.
 * Never blocks or breaks a screen: the outcome is in usePushState().
 */
export function usePushRegistration(signedIn: boolean): void {
  const register = trpc.push.register.useMutation();
  const { mutateAsync } = register;

  useEffect(() => {
    if (!signedIn || state.status !== "idle") return;
    setState({ status: "registering" });
    void (async () => {
      try {
        const t = await obtainPushToken();
        if (t.token === null) {
          setState({ status: "unavailable", reason: t.reason });
          return;
        }
        await mutateAsync({ token: t.token, platform: t.platform });
        setState({ status: "registered", token: t.token });
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [signedIn, mutateAsync]);
}

/** Back to "not registered" (after sign-out), so the next sign-in registers. */
export function resetPushState(): void {
  setState({ status: "idle" });
}
