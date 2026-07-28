import { useColorScheme } from "nativewind";

/**
 * Colours that have to be passed to React Native as *props* rather than as
 * classNames — `placeholderTextColor`, `ActivityIndicator`'s `color`,
 * `RefreshControl`'s tint. Tailwind cannot reach those, so they are the one
 * place the palette has to be duplicated in JS.
 *
 * Keep these in step with the tokens in global.css.
 */
export interface ThemeColors {
  muted: string;
  fg: string;
  accent: string;
  accentFg: string;
}

const LIGHT: ThemeColors = {
  muted: "#6b7280",
  fg: "#1b1d26",
  accent: "#4f46e5",
  accentFg: "#ffffff",
};

const DARK: ThemeColors = {
  muted: "#9ca3af",
  fg: "#f2f3f7",
  accent: "#a5b4fc",
  accentFg: "#16181d",
};

/**
 * The active palette. Follows the OS: NativeWind's colorScheme falls back to the
 * system value, and `darkMode: "class"` in tailwind.config.js is what makes that
 * observable readable (and settable) at all.
 */
export function useThemeColors(): ThemeColors {
  const { colorScheme } = useColorScheme();
  return colorScheme === "dark" ? DARK : LIGHT;
}
