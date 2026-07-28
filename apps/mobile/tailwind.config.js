/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],

  // "class", not the "media" default. Two reasons:
  //   1. With "media" NativeWind refuses to set the scheme at all — calling
  //      colorScheme.set()/toggle() throws "Unable to manually set color scheme
  //      without using darkMode: class", which surfaces as an uncaught error.
  //   2. It still follows the OS: NativeWind's colorScheme falls back to the
  //      system value until something overrides it. So this costs nothing and
  //      makes an in-app theme switch possible later.
  darkMode: "class",

  theme: {
    extend: {
      // Backed by the CSS variables in global.css, which define a light and a
      // dark value for each token. Same six-token approach as
      // apps/web/src/app/globals.css — keep the two in step so web and phone
      // stay recognisably the same product.
      colors: {
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        border: "var(--color-border)",
        fg: "var(--color-fg)",
        muted: "var(--color-muted)",
        accent: "var(--color-accent)",
        "accent-fg": "var(--color-accent-fg)",
        danger: "var(--color-danger)",
      },
    },
  },
  plugins: [],
};
