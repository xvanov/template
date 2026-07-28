import type { Metadata, Viewport } from "next";

import "./globals.css";

import { TRPCProvider } from "@/lib/trpc-provider";

export const metadata: Metadata = {
  title: "App Template",
  description: "Web + mobile app template — Next.js, Expo, tRPC, Prisma.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfd" },
    { media: "(prefers-color-scheme: dark)", color: "#16181d" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
