import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@repo/auth";

/**
 * The current session in a Server Component / Route Handler, or null.
 * Wrapped in React `cache()`: one lookup per request however many layouts,
 * pages and server helpers ask.
 */
export const getServerSession = cache(async () =>
  auth.api.getSession({ headers: await headers() }),
);

/**
 * The session, or a redirect to /login. Call it in EVERY /app page and in any
 * server-side data access — not only in the layout. Next renders layouts and
 * pages in parallel and may skip re-rendering a layout on client navigation,
 * so a layout-only check does not protect the page's own data fetching.
 * Cheap to repeat: the lookup is cached per request.
 */
export async function requireSession() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  return session;
}
