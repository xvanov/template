import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { FormatProvider } from "@/components/format-provider";
import { formatConfig } from "@/lib/format-server";
import { getServerSession } from "@/lib/session";

/**
 * The ONE auth guard for everything under /app. Server-side, so it is a control
 * rather than a suggestion: no /app page renders, and no /app data is fetched,
 * without a session. Pages below must not repeat the check — if a page needs
 * the user, call getServerSession() again (it is cheap) or read it from here.
 *
 * Per-user, so rendered per request and never cached.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  // The sidebar remembers open/collapsed in a cookie; read it here so the
  // first paint already has the right width (no layout jump).
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <FormatProvider config={formatConfig()}>
      <AppShell
        user={{ name: session.user.name, email: session.user.email }}
        defaultOpen={sidebarOpen}
      >
        {children}
      </AppShell>
    </FormatProvider>
  );
}
