import { useSession } from "../lib/auth";
import { usePushRegistration } from "../lib/use-push";

/** Registers this install for push once signed in. Renders nothing. */
export function PushRegistrar() {
  const { data: session } = useSession();
  usePushRegistration(Boolean(session?.user));
  return null;
}
