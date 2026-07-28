import { redirect } from "next/navigation";

import { Dashboard } from "@/components/dashboard";
import { getServerSession } from "@/lib/session";

/**
 * Per-user page: it reads the session cookie, so it must be rendered per request
 * and never cached. Being explicit also stops `next build` from attempting a
 * prerender, which would make compiling the app require runtime secrets.
 */
export const dynamic = "force-dynamic";
export default async function AppPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  return (
    <Dashboard
      user={{
        name: session.user.name,
        email: session.user.email,
      }}
    />
  );
}
