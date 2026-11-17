import { cookies } from "next/headers";

import { AppShell } from "@/components/app-shell";
import { FormatProvider } from "@/components/format-provider";
import { Toaster } from "@/components/ui/sonner";
import { formatConfig } from "@/lib/format-server";
import { requireSession } from "@/lib/session";

/**
 * Auth for /app, layer one: no /app chrome renders without a session.
 *
 * This is NOT sufficient on its own. Next renders layouts and pages in
 * parallel and can skip a layout on client navigation, so every /app page (and
 * any server-side data access) also calls requireSession() — cached per
 * request, so the repeat costs nothing.
 *
 * Per-user, so rendered per request and never cached.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

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
      <Toaster richColors closeButton />
    </FormatProvider>
  );
}
