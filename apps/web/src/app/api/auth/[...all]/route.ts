/**
 * Every auth endpoint — sign-in, sign-up, OAuth callback, session, and the
 * organization plugin's routes — is served from here. The mobile app calls the
 * same URLs.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@repo/auth";

export const { GET, POST } = toNextJsHandler(auth);
