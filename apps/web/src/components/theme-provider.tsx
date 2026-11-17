"use client";

/**
 * next-themes, configured once. It injects a tiny blocking script that sets
 * `class="dark"` on <html> before first paint, so there is no light flash for a
 * dark-mode user. `<html suppressHydrationWarning>` in the root layout is the
 * other half of that: the server cannot know the class the script will set.
 */
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { useEffect, type ReactNode } from "react";

/** Must match the `themeColor` entries in app/layout.tsx (--background). */
const THEME_COLOR = { light: "#ffffff", dark: "#0a0a0a" } as const;

/**
 * The <meta name="theme-color"> tags follow the OS (media queries). When the
 * user pins a theme, point them all at the chosen colour so the browser /
 * phone status bar matches the page.
 */
function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute("content", THEME_COLOR[resolvedTheme]);
    }
  }, [resolvedTheme]);
  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ThemeColorSync />
      {children}
    </NextThemesProvider>
  );
}
