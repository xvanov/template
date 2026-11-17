"use client";

/**
 * next-themes, configured once. It injects a tiny blocking script that sets
 * `class="dark"` on <html> before first paint, so there is no light flash for a
 * dark-mode user. `<html suppressHydrationWarning>` in the root layout is the
 * other half of that: the server cannot know the class the script will set.
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
