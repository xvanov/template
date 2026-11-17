"use client";

/**
 * Light/dark switch that can always get back to "follow the OS".
 *
 * A click flips what is showing. Flipping to the theme the OS already uses
 * selects "system" rather than pinning it, so: OS dark → click → light (pinned)
 * → click → dark again AND following the OS. Two states to click through,
 * never a click that changes nothing.
 *
 * The icon is chosen by CSS (`dark:` variants) rather than by reading the theme
 * in JS, so it is right on the very first paint and needs no "mounted" guard.
 * A plain button rather than a menu on purpose: it keeps Radix's menu and
 * positioning code off pages that have no other use for them (home, login).
 */
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, systemTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("relative", className)}
      aria-label="Toggle dark mode"
      onClick={() => {
        const next = resolvedTheme === "dark" ? "light" : "dark";
        setTheme(next === systemTheme ? "system" : next);
      }}
    >
      <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
    </Button>
  );
}
