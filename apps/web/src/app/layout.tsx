import type { Metadata, Viewport } from "next";

import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { TRPCProvider } from "@/lib/trpc-provider";

export const metadata: Metadata = {
  title: { default: "App Template", template: "%s · App Template" },
  description: "Web + mobile app template — Next.js, Expo, tRPC, Prisma.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches --background in globals.css (light / dark).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

/**
 * Deliberately reads nothing per-request (no env(), no cookies): static pages
 * such as /design must prerender at build time, and the Docker build has no
 * runtime secrets. Per-user setup lives in app/app/layout.tsx.
 *
 * Only what every page needs goes here. The toast <Toaster> is mounted by the
 * pages that toast (/app layout, /design), keeping sonner off / and /login.
 *
 * `suppressHydrationWarning` is required by next-themes: its inline script sets
 * the theme class on <html> before React hydrates.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <ThemeProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
