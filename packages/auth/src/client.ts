/**
 * Browser auth client (web app only).
 *
 * No `baseURL` on purpose: better-auth then talks to the ORIGIN THE PAGE WAS
 * SERVED FROM. Baking an absolute URL in at build time breaks the app on every
 * origin that is not the one it was built for — a preview deploy, a tunnel
 * hostname, the smoke gate's isolated port. Same-origin is correct everywhere.
 *
 * The mobile app builds its own client in `apps/mobile/lib/auth.ts`: it has no
 * page origin to inherit, and it needs the Expo plugin + SecureStore, which
 * must not be pulled into a web bundle.
 */
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
