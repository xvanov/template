import type { MetadataRoute } from "next";

/**
 * Web app manifest (served at /manifest.webmanifest): lets the app be installed
 * to a phone's home screen and open full-screen at /app. Rename alongside the
 * <title> in layout.tsx; colours match --background in globals.css.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "App Template",
    short_name: "App",
    description: "Web + mobile app template — Next.js, Expo, tRPC, Prisma.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
