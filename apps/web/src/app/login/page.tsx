import { redirect } from "next/navigation";
import { env, googleEnabled } from "@repo/env";

import { LoginForm } from "@/components/login-form";
import { getServerSession } from "@/lib/session";

/**
 * Per-user page: it reads the session cookie, so it must be rendered per request
 * and never cached. Being explicit also stops `next build` from attempting a
 * prerender, which would make compiling the app require runtime secrets.
 */
export const dynamic = "force-dynamic";
/**
 * The mode lives in the URL rather than in client state, so `/login?mode=signup`
 * is linkable, server-renders the right heading, and does not depend on a click
 * landing after hydration.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const session = await getServerSession();
  if (session?.user) redirect("/app");

  const { mode } = await searchParams;

  // Whether Google is configured is a server fact; the client only ever
  // receives the boolean, never the credentials.
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <LoginForm
        googleEnabled={googleEnabled()}
        mode={mode === "signup" ? "signup" : "signin"}
        devInboxUrl={env().DEV_MAIL_INBOX_URL ?? null}
      />
    </main>
  );
}
