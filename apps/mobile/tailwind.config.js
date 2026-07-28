/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      // Mirrors the six tokens in apps/web/src/app/globals.css. Keep the two in
      // step so web and phone stay recognisably the same product.
      colors: {
        bg: "#fbfbfd",
        surface: "#ffffff",
        border: "#e4e4ed",
        fg: "#1b1d26",
        muted: "#6b7280",
        accent: "#4f46e5",
        "accent-fg": "#ffffff",
        danger: "#dc2626",
      },
    },
  },
  plugins: [],
};
